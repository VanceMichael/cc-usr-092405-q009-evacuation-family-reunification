import express from "express";
import { pathToFileURL } from "node:url";
import { openDatabase, verifyAuditChain } from "./db.js";
import { createService, ServiceError } from "./service.js";
import { Role } from "./contracts.js";

export function createApp(options = {}) {
  const db = options.db ?? openDatabase(options.dbOptions ?? { dbPath: options.dbPath ?? ".data/muster.sqlite" });
  const service = createService(db, options.serviceOptions ?? {});
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.set("db", db);
  app.set("service", service);

  app.get("/health", (_request, response) => response.json({ status: "ok", service: "evacuation-muster" }));

  // 调用身份：离线内网部署，以 X-Actor-Id 标识工作人员账号（角色取自服务端账户表，不信客户端）
  function authenticate(request, response, next) {
    const actorId = request.header("x-actor-id");
    if (!actorId) return response.status(401).json({ error: "missing_actor", message: "缺少 X-Actor-Id" });
    try {
      request.actor = service.getActor(actorId);
      next();
    } catch (err) {
      next(err);
    }
  }
  function requireRole(...roles) {
    return (request, response, next) => {
      if (!roles.includes(request.actor.role)) {
        return response.status(403).json({ error: "forbidden_role", message: "该角色无权执行此操作", allowed_roles: roles });
      }
      next();
    };
  }
  const wrap = (handler) => (request, response, next) =>
    Promise.resolve()
      .then(() => handler(request, response))
      .catch((err) => next(err));

  const v1 = express.Router();
  v1.use(authenticate);

  // 登记（在线直录；离线设备见 device-events）
  v1.post("/registrations",
    requireRole(Role.WORKER, Role.SPECIALIST),
    wrap((req, res) => res.status(201).json(service.registerDirect(req.actor, req.body))));

  // 离线设备流水：同一 (device_id, seq) 重传返回 duplicate，绝不重复入库
  v1.post("/device-events",
    requireRole(Role.WORKER),
    wrap((req, res) => res.status(202).json(service.ingestDeviceEvent(req.actor, req.body))));

  // 候选：工作人员只见本点脱敏视图
  v1.get("/candidates",
    requireRole(Role.WORKER),
    wrap((req, res) => res.json({ candidates: service.listCandidatesForWorker(req.actor) })));
  v1.get("/candidates/:id",
    requireRole(Role.WORKER, Role.SPECIALIST),
    wrap((req, res) => res.json(service.viewCandidate(req.actor, req.params.id))));

  // 发起团聚安排（自动路由：双方确认 / 专门复核）
  v1.post("/candidates/:id/arrangements",
    requireRole(Role.WORKER),
    wrap((req, res) => res.status(201).json(service.startArrangement(req.actor, req.params.id))));
  v1.get("/arrangements/:id",
    wrap((req, res) => res.json(service.arrangementView(req.actor, req.params.id))));

  // 普通成年人：工作人员向本侧一方发放短期确认凭据，当事人持凭据分别确认
  v1.post("/arrangements/:id/confirmation-tokens",
    requireRole(Role.WORKER),
    wrap((req, res) => res.status(201).json(
      service.issueConfirmationToken(req.actor, req.params.id, String(req.body?.side ?? "")))));
  v1.post("/arrangements/:id/decline",
    requireRole(Role.WORKER),
    wrap((req, res) => res.json(service.declineArrangement(req.actor, req.params.id, String(req.body?.side ?? ""), req.body?.reason))));

  // 专门复核队列
  v1.get("/reviews",
    requireRole(Role.SPECIALIST),
    wrap((req, res) => res.json({ queue: service.reviewQueue() })));
  v1.get("/reviews/:id",
    requireRole(Role.SPECIALIST),
    wrap((req, res) => res.json(service.reviewDetail(req.actor, req.params.id, req.query.full === "1"))));
  v1.post("/reviews/:id/decision",
    requireRole(Role.SPECIALIST),
    wrap((req, res) => res.json(service.specialistDecision(req.actor, req.params.id, String(req.body?.decision ?? ""), req.body?.note))));

  // 会合凭据换发（仅生效地点）
  v1.post("/arrangements/:id/rendezvous/reissue",
    requireRole(Role.WORKER, Role.SPECIALIST),
    wrap((req, res) => res.json(service.reissueRendezvous(req.actor, req.params.id))));

  // 人员转移 / 撤离状态更正 / 新限制（未完成安排联动调整，已完成追加风险说明）
  v1.post("/registrations/:id/transfer",
    requireRole(Role.WORKER, Role.SPECIALIST, Role.COMMANDER),
    wrap((req, res) => res.json(service.applyTransfer(req.actor.id, req.params.id, req.body?.to_site_id))));
  v1.post("/registrations/:id/status",
    requireRole(Role.WORKER, Role.SPECIALIST, Role.COMMANDER),
    wrap((req, res) => res.json(service.applyStatusCorrection(req.actor.id, req.params.id, req.body?.status, req.body?.note))));
  v1.post("/registrations/:id/restrictions",
    requireRole(Role.WORKER, Role.SPECIALIST),
    wrap((req, res) => res.json(service.applyRestriction(req.actor.id, req.params.id, req.body?.flag, req.body?.note))));

  // 系统恢复后续期检查：凭据按原有效期继续，超时者释放，返回复核队列
  v1.post("/reconcile",
    wrap((req, res) => res.json(service.reconcile())));

  // 指挥席：汇总与阻塞原因（无 PII）
  v1.get("/command/summary",
    requireRole(Role.COMMANDER),
    wrap((req, res) => res.json(service.commandSummary())));

  // 审计员：重建匹配线索 / 敏感信息访问者 / 最终确认过程
  v1.get("/audit/chain",
    requireRole(Role.AUDITOR),
    wrap((req, res) => res.json(verifyAuditChain(db))));
  v1.get("/audit/accesses",
    requireRole(Role.AUDITOR),
    wrap((req, res) => res.json({ accesses: service.auditAccesses() })));
  v1.get("/audit/:kind/:id",
    requireRole(Role.AUDITOR),
    wrap((req, res) => res.json(service.auditAccess(req.actor, req.params.kind, req.params.id))));

  // 当事人持凭据自助确认 / 查看会合信息：凭据即授权，不需要 X-Actor-Id。
  // 必须在鉴权路由器挂载之前注册，否则会先被 authenticate 拦截。
  app.post("/v1/confirm", wrap((req, res) => res.json(service.confirmByToken(req.body?.token))));
  app.post("/v1/rendezvous", wrap((req, res) => res.json(service.rendezvousByToken(req.body?.token))));

  app.use("/v1", v1);

  app.use((err, _request, response, _next) => {
    if (err instanceof ServiceError) {
      return response.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err?.type === "entity.parse.failed") {
      return response.status(400).json({ error: "invalid_json", message: "请求体不是合法 JSON" });
    }
    return response.status(500).json({ error: "internal_error", message: "服务内部错误" });
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
}
