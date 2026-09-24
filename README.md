# 撤离清点服务（evacuation-muster）

面向临时安置点的失联登记与团聚确认服务。处理离线设备重复登记、疑似同一人候选、分级确认、会合凭据与审计重建。

## 核心规则（与代码一一对应）

1. **最少信息登记**：每条登记只保存身份线索（≤5 项）、关系声明、最后接触地点、可联系时段；家属在不同地点的重复登记各自独立，**系统不自动合并人**。
2. **离线设备流水**：同步以 `(device_id, seq)` 标识，同序号同内容重传返回首次结果（`replayed: true`），同序号不同内容拒绝 409，序号必须连续，新设备从 1 开始。
3. **候选而非合并**：两两比对产出 `high/medium/low` 候选，附分值与因子依据（`factors`）。仅凭姓名（即使叠加年龄、性别等人口学弱属性）不能安排见面——必须有接触地点、共有身份线索或别名等强佐证。
4. **脱敏视图**：工作人员只看到本安置点候选，姓名（`张*`）、地点（`城南**`）、联系渠道（`***`）脱敏；不展示完整名单与线索原值。
5. **分级确认**：
   - 普通成年人：双方所在安置点工作人员**分别确认**后才签发凭据；
   - 未成年人、监护争议、限制接触：自动转专门人员（specialist）复核，邻居临时代看等情形不能双方直认。
6. **独占生效**：同一登记（寻人或在场）在任一时点只能被一处安排占用；两个地点同时发起，后到者收到 409。
7. **短期凭据**：确认窗口默认 2 小时，会合凭据默认 4 小时（墙上时钟时间，落库持久化）。凭据只含会合点、时段、是否需监督，不含身份线索原值。
8. **拒绝/超时**：释放占用、候选重新开放，但登记（原申请）与安排行以 `rejected/expired` 终结状态保留，不删除。
9. **状态变更联动**：人员转移、撤离状态更正、新限制到达时——未完成安排释放或转复核并作废凭据；**已完成团聚保留当时授权快照**，只追加风险说明。
10. **重启延续**：服务启动即扫描；凭据到期、确认截止按持久化的绝对时间继续生效。
11. **指挥席**：只见汇总计数与阻塞原因（缺确认、待复核、待会合），不见姓名线索。
12. **审计**：仅 auditor 可按安排或登记重建匹配所用线索原值、敏感信息访问者（谁看过全值/凭据）、最终确认过程时间线；审计访问本身也留痕。

## 角色（`x-staff-id` 头标识，种子数据）

| ID | 角色 | 权限 |
|----|------|------|
| `w1` / `w2` | worker | 绑定 S1/S2，登记、查看本点脱敏候选、发起与确认本点安排 |
| `sp1` | specialist | 复核队列、查看原值、批准/驳回暖情形成安排、登记限制 |
| `cmd1` | commander | `GET /command/summary` 汇总与阻塞 |
| `aud1` | auditor | `GET /audit/reconstruction` 重建 |

> 种子身份仅用于演练/测试；生产部署应替换为真实身份提供方（见“运维”）。

## API 概览

| 方法与路径 | 说明 |
|---|---|
| `POST /sync` | 离线设备批量同步（幂等流水） |
| `POST /reports` | 终端在线登记 |
| `GET /candidates` | 本点脱敏候选（含分值与因子） |
| `POST /candidates/:id/dismiss` | 排除候选（需无在途安排） |
| `POST /candidates/:id/arrangements` | 发起安排（独占占用 + 自动分级） |
| `GET /arrangements/:id` | 安排详情（worker 脱敏 / specialist 全值，访问留痕） |
| `POST /arrangements/:id/confirm` | 一方确认 `{side:"seeking"|"located"}` |
| `POST /arrangements/:id/reject` | 一方拒绝 `{side, reason}` |
| `GET /reviews` / `POST /arrangements/:id/review` | 专员复核队列 / 决定 |
| `GET /arrangements/:id/credential` | 取有效凭据与会合必要信息 |
| `POST /arrangements/:id/complete` | 登记团聚完成（冻结授权快照） |
| `POST /restrictions` | 新增限制接触/监护争议 `{type, subject_report_id, counterparty_report_id}` |
| `POST /reports/:id/transfer` | 人员转移 `{to_site_id}` |
| `POST /reports/:id/evac-correction` | 撤离状态更正 `{evac_status, current_site_id?}` |
| `GET /command/summary` | 汇总与阻塞原因 |
| `GET /audit/reconstruction?arrangement_id=` 或 `?report_id=` | 审计重建 |

安排状态机：`pending → approved → completed`；敏感情形 `in_review → approved → completed`；任何非完成态可走向 `rejected / expired / released`，占用随之释放、候选重新开放。

## 本地开发

```bash
npm install
npm test      # node:test + supertest，42 个用例
npm run build # 全部源文件语法检查
npm start     # 默认 .data/muster.db，监听 8080
```

环境变量：`PORT`（默认 8080）、`DB_PATH`（默认 `.data/muster.db`）。

快速演练：

```bash
curl -s localhost:8080/health
curl -s -H 'x-staff-id: w1' -H 'content-type: application/json' \
  -d '{"side":"seeking","person_name":"李华","est_age":34,"last_contact_place":"三号桥","clues":[{"type":"tattoo","value":"手腕玫瑰"}]}' \
  localhost:8080/reports
```

## Docker

```bash
docker build -t evacuation-muster .
docker run --rm -p 8080:8080 -v "$PWD/.data:/app/.data" evacuation-muster
```

镜像构建时会执行 `npm test`。挂载 `.data` 可在容器重建后保留登记、凭据有效期与审计轨迹。

## 代码结构

- `src/contracts.js` — 角色、状态、阻塞原因、评分权重与阈值
- `src/db.js` — SQLite 表结构与种子数据
- `src/matching.js` — 纯函数评分引擎（规范化、因子、强佐证判定）
- `src/masking.js` — 姓名/地点/渠道脱敏
- `src/services.js` — 事务化业务逻辑（登记、幂等、候选、安排生命周期、调整、汇总、审计）
- `src/server.js` — Express 路由、错误映射、启动超时扫描

## 运维与安全说明

- 所有时间以 ISO 字符串绝对时间落库；重启后以墙上时钟判定过期，离线设备回传不影响 TTL 计算。
- 敏感信息访问（全值详情、凭据、审计重建）写入 `audit_events`；生产环境接入反向代理认证后，应把 `x-staff-id` 替换为认证后身份并保留同样的审计动作。
- 匹配是**确定性规则评分**，不调用外部服务；调分只改 `contracts.js` 的权重与阈值，历史候选保留当时的因子快照。
