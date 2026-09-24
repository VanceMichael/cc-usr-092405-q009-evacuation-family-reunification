# 撤离清点服务（失联登记与团聚确认）

面向临时安置点的离线优先服务：家属在不同地点重复登记失联人员时，系统只保存最少身份线索，
将疑似同一人的记录形成**带置信依据的候选**而不自动合并；工作人员只能看到本安置点的脱敏候选；
普通成年人由双方分别确认，未成年人、监护争议或限制接触交专门人员复核；凭据短期有效，
会合时只披露必要信息。

`src/contracts.js` 提供全部状态/角色常量，SQLite 文件保存在 `.data/` 目录。

## 运行

```bash
npm test                 # 全部测试（node:test + supertest）
npm run build            # 语法检查
npm start                # 本地启动，默认 0.0.0.0:8080
docker build -t evacuation-muster .
docker run --rm -p 8080:8080 evacuation-muster
```

进程状态：`GET /health`。

## 身份模型

离线内网部署，请求带 `X-Actor-Id`，角色取自服务端账户表（不信客户端自报角色）。预置账号：

| 账号 | 角色 | 权限边界 |
|---|---|---|
| `worker-a/b/c` | 安置点工作人员 | 只能登记/查看/操作本点（登记点或当事人当前所在点）相关数据 |
| `specialist-1/2` | 专门复核人员 | 复核队列；默认看脱敏视图，`full=1` 才解开脱敏且**每次留痕** |
| `commander-1` | 指挥席 | 仅汇总数字与阻塞原因，无任何 PII |
| `auditor-1` | 授权审计员 | 唯一可重建匹配线索、敏感访问者、确认过程的角色 |

## 数据最小化

登记仅保存：姓名、近似年龄/年龄段、最多 3 条体貌特征、关系声明（含"邻居临时代看"）、
登记人、联系方式（可选）、可联系时段、最后接触地点/时间、限制标记。不保存证件号、详细住址。

工作人员看到的对侧数据为脱敏视图：姓名首字（`张**`）、电话首尾（`13****22`）、
地点粗粒度（`城北体育馆`，略去门牌号）、仅日期、特征首字；不回显匹配依据中的明文值。
完整名单不存在任何可公开导出的接口。

## 匹配策略（`src/matching.js`）

- 姓名归一化相同是进入候选的**必要条件**，但同名本身不构成候选；
- 必须至少还有一条独立线索（年龄段/近似年龄/共同体貌特征/最后接触地点粗或细/48 小时时间窗）；
- 输出分数与置信度 `low / medium / high`，并保留每条依据的类别、权重与原因（审计可重建）；
- 候选只供人工判断，**绝不自动合并**，两份原始登记始终保留。

## 团聚流程

```
登记(多地点) ──> 候选(带依据, 脱敏可见) ──> 发起安排
                                         ├─ 普通成年人: awaiting_confirmations
  两边工作人员各发短期凭据(仅哈希入库) ──> 双方分别持凭据 POST /v1/confirm
                                         │      └─ 双方齐 ──> confirmed（单赢裁决）
                                         └─ 未成年/监护争议/限制接触/邻居代看儿童
                                                └─ pending_review ──> 专门人员批准/驳回
confirmed ──> 会合凭据（短期，只含会合点、监督提示、双方可联系时段交集）
```

- **凭据短期有效**：确认凭据默认 30 分钟、会合凭据默认 2 小时；令牌只存 SHA-256 哈希。
- **只披露会合必要信息**：会合响应不含姓名、电话、完整地址；含监督提示（有限制接触时为 supervised）。
- **拒绝 / 超时**：安排进入 `released`（原因 `declined`/`timeout`），候选回到可重新发起状态，
  **原登记申请永不删除**。
- **两地单赢**：同一人在多个地点的安排可以并行等待，但完成时以最先落库的生效，
  后完成者释放为 `conflict_lost`（该候选随之失效），申请同样保留。
- **人员转移 / 状态更正 / 新限制**（未完成安排随动）：
  - 转移：待确认安排继续有效，会合点按当事人新所在点自动调整，新点工作人员可接手；
  - 状态更正为不可匹配（如 deceased/withdrawn）：未完成安排释放、候选失效；
  - 新限制到达（restricted_contact/custody_dispute）：待确认安排**改道**专门复核，
    已发出的凭据立即作废（token 世代 +1、哈希清空）；
  - 对**已完成**团聚：一律保留当时授权，只在安排上追加带时间戳的风险说明。
- **停机恢复** `POST /v1/reconcile`：确认/会合凭据按原截止时间继续（返回剩余毫秒数，不重设），
  过期安排统一释放，复核队列原样保留。

## 离线设备流水

离线设备以 `(device_id, seq)` 游标识事件；重传同一流水号返回 `duplicate:true`，绝不重复入库。
事件类型：`registration` / `transfer` / `status_correction` / `restriction`。
事件应用在单个事务内完成，失败不留半写入，设备可按本地游标重试。

## 主要接口（前缀 `/v1`）

| 方法与路径 | 角色 | 说明 |
|---|---|---|
| `POST /registrations` | worker/specialist | 在线直录 |
| `POST /device-events` | worker | 离线流水（幂等） |
| `GET /candidates` `GET /candidates/:id` | worker(+specialist) | 本点脱敏候选 |
| `POST /candidates/:id/arrangements` | worker | 发起安排（自动路由） |
| `POST /arrangements/:id/confirmation-tokens` | worker | 向本侧一方发短期凭据 |
| `POST /arrangements/:id/decline` | worker | 一方拒绝 |
| `POST /confirm` | 公开（凭据即授权） | 当事人分别确认 |
| `POST /rendezvous` | 公开（凭据即授权） | 取会合必要信息 |
| `POST /arrangements/:id/rendezvous/reissue` | 生效点 worker/specialist | 会合凭据换发 |
| `GET /reviews` `GET /reviews/:id?full=1` `POST /reviews/:id/decision` | specialist | 复核队列与决定 |
| `POST /registrations/:id/transfer` `/status` `/restrictions` | worker/specialist(+commander) | 状态联动 |
| `POST /reconcile` | 任意登录账号 | 恢复后续期与队列检查 |
| `GET /command/summary` | commander | 汇总与阻塞原因（无 PII） |
| `GET /audit/accesses` `/audit/chain` `/audit/:kind/:id` | auditor | 访问者名单、哈希链校验、线索/确认过程重建 |

## 审计与防篡改

`audit_log` 为只追加表，每条记录包含前一条的 SHA-256 哈希（链式），
覆盖：登记、候选形成、安排状态变化、**每次敏感信息解开脱敏**、双方确认、复核决定、
风险追加、凭据换发。`GET /v1/audit/chain` 可校验链完整性；任何行被修改都会被检出。
审计员自己的重建访问同样写入该链。

## 代码结构

```
src/contracts.js  状态/角色/路由/TTL 常量
src/util.js       归一化、脱敏原语、时段交集、随机令牌/哈希
src/matching.js   候选打分与置信依据（不自动合并）
src/masking.js    工作人员/专门人员的脱敏视图
src/db.js         SQLite schema、种子账号、哈希链审计
src/service.js    领域服务：登记、流水幂等、状态机、凭据、联动、汇总
src/server.js     Express 路由与角色鉴权
test/             35 项测试（领域不变量 + HTTP 鉴权/流程）
```
