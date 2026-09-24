// 撤离清点 / 失联登记与团聚确认领域常量

export const BatchState = Object.freeze({ OPEN: "open", CLOSED: "closed" });
export const ArrivalKind = Object.freeze({ ON_TIME: "on_time", LATE: "late", DUPLICATE: "duplicate" });

// 人员撤离状态（可由状态更正事件更新）
export const PersonStatus = Object.freeze({
  MISSING: "missing",         // 失联
  LOCATED: "located",         // 已找到
  EVACUATED: "evacuated",     // 已撤离
  TRANSFERRED: "transferred", // 已转移
  DECEASED: "deceased",       // 确认死亡
  WITHDRAWN: "withdrawn",     // 申请撤回 / 确认并非同一人
});

// 仍可参与匹配的状态
export const MATCHABLE_STATUSES = Object.freeze([
  PersonStatus.MISSING,
  PersonStatus.LOCATED,
  PersonStatus.EVACUATED,
  PersonStatus.TRANSFERRED,
]);

export const AgeBand = Object.freeze({ CHILD: "child", ADULT: "adult", UNKNOWN: "unknown" });

// 限制 / 风险标记
export const Restriction = Object.freeze({
  RESTRICTED_CONTACT: "restricted_contact", // 限制接触（如禁令）
  CUSTODY_DISPUTE: "custody_dispute",       // 监护争议
});

// 候选（疑似同一人）状态：只形成候选，不自动合并
export const CandidateStatus = Object.freeze({
  PROPOSED: "proposed",       // 待处理
  CONFIRMED: "confirmed",     // 已有生效团聚
  SUPERSEDED: "superseded",   // 依据失效
});

// 团聚安排路由
export const ArrangementRoute = Object.freeze({
  MUTUAL_CONFIRM: "mutual_confirm",       // 普通成年人：双方分别确认
  SPECIALIST_REVIEW: "specialist_review", // 未成年 / 监护争议 / 限制接触：专门人员复核
});

// 团聚安排状态
export const ArrangementState = Object.freeze({
  PENDING_REVIEW: "pending_review",
  AWAITING_CONFIRMATIONS: "awaiting_confirmations",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  RELEASED: "released",
});

// 安排终结（非生效）原因；原申请始终保留
export const ReleaseReason = Object.freeze({
  TIMEOUT: "timeout",
  DECLINED: "declined",
  REVIEW_REJECTED: "review_rejected",
  STATUS_CORRECTION: "status_correction",
  CONFLICT_LOST: "conflict_lost", // 另一地点已先生效
});

export const Role = Object.freeze({
  WORKER: "worker",         // 安置点工作人员：只见本点脱敏候选
  SPECIALIST: "specialist", // 专门复核人员
  COMMANDER: "commander",   // 指挥席：汇总与阻塞原因
  AUDITOR: "auditor",       // 授权审计员：重建线索 / 访问者 / 确认过程
});

// 离线设备流水事件类型
export const DeviceEventType = Object.freeze({
  REGISTRATION: "registration",
  TRANSFER: "transfer",
  STATUS_CORRECTION: "status_correction",
  RESTRICTION: "restriction",
});

// 默认凭据有效期（毫秒）
export const DEFAULT_CONFIRM_TTL_MS = 30 * 60 * 1000;       // 双方确认凭据 30 分钟
export const DEFAULT_RENDEZVOUS_TTL_MS = 2 * 60 * 60 * 1000; // 会合凭据 2 小时
