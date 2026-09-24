// 业务枚举与阈值。所有跨模块共享的字符串只能出自此处，禁止在逻辑里写裸值。

export const Role = Object.freeze({
  WORKER: "worker", // 安置点工作人员：只见本点脱敏候选
  SPECIALIST: "specialist", // 专门人员：未成年人/监护争议/限制接触复核
  COMMANDER: "commander", // 指挥席：只见汇总与阻塞原因
  AUDITOR: "auditor", // 授权审计员：可重建匹配线索与确认过程
});

export const ReportSide = Object.freeze({
  SEEKING: "seeking", // 家属登记的失联寻人记录
  LOCATED: "located", // 现场登记的在场/已找到人员
});

// 候选置信度：只表达“疑似同一人”，永远不触发自动合并
export const Confidence = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
});

// 匹配评分因子（作为“置信依据”落库并向工作人员展示因子名，不展示线索原值）
export const MatchFactor = Object.freeze({
  NAME_EXACT: "name_exact", // 规范化姓名完全相同
  NAME_ALIAS: "name_alias", // 姓名与别名一致
  NAME_PARTIAL: "name_partial", // 姓名部分重合
  AGE_BAND: "age_band", // 年龄段一致
  AGE_CLOSE: "age_close", // 估计年龄相差很小
  GENDER: "gender", // 性别一致
  PLACE_EXACT: "place_exact", // 最后接触地点一致
  PLACE_PARTIAL: "place_partial", // 最后接触地点存在包含关系
  SHARED_CLUE: "shared_clue", // 共有身份线索
});

export const ArrangementStatus = Object.freeze({
  PENDING: "pending", // 普通成年人：等待双方分别确认
  IN_REVIEW: "in_review", // 敏感情形：等待专门人员复核
  APPROVED: "approved", // 已确认，凭据已签发，等待会合
  COMPLETED: "completed", // 团聚已完成，授权快照冻结
  REJECTED: "rejected", // 一方拒绝；释放占用，原申请保留
  EXPIRED: "expired", // 确认超时；释放占用，原申请保留
  RELEASED: "released", // 转移/状态更正/新限制导致调整；凭据作废
});

// 指挥席可见的阻塞原因
export const BlockerReason = Object.freeze({
  AWAITING_SIDE_CONFIRMATION: "awaiting_side_confirmation",
  AWAITING_SPECIALIST_REVIEW: "awaiting_specialist_review",
  AWAITING_MEETING: "awaiting_meeting",
});

export const RestrictionType = Object.freeze({
  CONTACT: "contact_restriction", // 限制接触
  CUSTODY_DISPUTE: "custody_dispute", // 监护争议
});

export const EvacStatus = Object.freeze({
  UNKNOWN: "unknown",
  ON_SITE: "on_site", // 已在某安置点
  IN_TRANSIT: "in_transit", // 转移途中
  EVACUATED_ELSEWHERE: "evacuated_elsewhere", // 确认在其他点
  HOSPITAL: "hospital",
});

export const ReleaseReason = Object.freeze({
  REJECTED: "rejected",
  TIMEOUT: "timeout",
  TRANSFER: "transfer",
  EVAC_CORRECTION: "evac_correction",
  RESTRICTION: "new_restriction",
});

// 评分阈值：仅凭姓名相同（40 分）最高只能到 medium，不构成高置信
export const SCORE_WEIGHTS = Object.freeze({
  nameExact: 40,
  nameAlias: 35,
  namePartial: 20,
  ageBand: 10,
  ageClose: 10,
  gender: 10,
  placeExact: 20,
  placePartial: 10,
  sharedClueEach: 12,
  sharedClueCap: 24,
});

export const SCORE_THRESHOLDS = Object.freeze({
  candidateMin: 18,
  high: 55,
  medium: 35,
});

export const AgeBand = Object.freeze({
  INFANT: "0-2",
  CHILD: "3-11",
  ADOLESCENT: "12-17",
  ADULT: "18-59",
  ELDER: "60+",
});

export function ageBandFor(age) {
  if (age == null || Number.isNaN(age)) return null;
  if (age <= 2) return AgeBand.INFANT;
  if (age <= 11) return AgeBand.CHILD;
  if (age <= 17) return AgeBand.ADOLESCENT;
  if (age <= 59) return AgeBand.ADULT;
  return AgeBand.ELDER;
}

// 允许相邻年龄段给少量置信（如 17 与 18 岁）
const BAND_ORDER = [AgeBand.INFANT, AgeBand.CHILD, AgeBand.ADOLESCENT, AgeBand.ADULT, AgeBand.ELDER];

export function bandsAdjacent(a, b) {
  const ia = BAND_ORDER.indexOf(a);
  const ib = BAND_ORDER.indexOf(b);
  return ia >= 0 && ib >= 0 && Math.abs(ia - ib) === 1;
}

export const CLUE_LIMITS = Object.freeze({ maxItems: 5, maxValueLength: 80 });
