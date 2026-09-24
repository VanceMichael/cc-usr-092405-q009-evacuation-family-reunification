import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  Role,
  ReportSide,
  ArrangementStatus,
  BlockerReason,
  RestrictionType,
  EvacStatus,
  ReleaseReason,
  CLUE_LIMITS,
  ageBandFor,
} from "./contracts.js";
import { scorePair, isNameOnly, hasStrongCorroboration } from "./matching.js";
import { maskName, maskPlace, maskWindows } from "./masking.js";

const CONFIRM_TTL_MS = 2 * 60 * 60 * 1000; // 双方确认窗口
const CREDENTIAL_TTL_MS = 4 * 60 * 60 * 1000; // 会合凭据短期有效

export const TIMING = Object.freeze({ CONFIRM_TTL_MS, CREDENTIAL_TTL_MS });

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const nowIso = (clock) => new Date(clock()).toISOString();

export function createServices(db, { clock = () => Date.now(), ttl = {} } = {}) {
  const confirmTtl = ttl.confirm ?? CONFIRM_TTL_MS;
  const credTtl = ttl.credential ?? CREDENTIAL_TTL_MS;

  const q = {
    staff: db.prepare("SELECT * FROM staff WHERE staff_id = ?"),
    site: db.prepare("SELECT * FROM sites WHERE site_id = ?"),
    report: db.prepare("SELECT * FROM reports WHERE report_id = ?"),
    candidate: db.prepare("SELECT * FROM match_candidates WHERE candidate_id = ?"),
    arrangement: db.prepare("SELECT * FROM arrangements WHERE arrangement_id = ?"),
    activeClaim: db.prepare("SELECT * FROM active_claims WHERE report_id = ?"),
  };

  function audit(staffId, action, entityType, entityId = "", detail = {}) {
    db.prepare(
      "INSERT INTO audit_events (at, actor_id, action, entity_type, entity_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(nowIso(clock), staffId, action, entityType, entityId, JSON.stringify(detail));
  }

  function requireStaff(staffId, roles) {
    const staff = staffId && q.staff.get(staffId);
    if (!staff) throw new ApiError(401, "unknown_staff", "工作人员身份无效");
    if (roles && !roles.includes(staff.role)) {
      throw new ApiError(403, "forbidden_role", "该角色无权执行此操作");
    }
    return staff;
  }

  // ---------- 登记校验与落库 ----------

  function validateReportBody(body) {
    const side = body.side;
    if (![ReportSide.SEEKING, ReportSide.LOCATED].includes(side)) {
      throw new ApiError(400, "bad_side", "side 必须是 seeking 或 located");
    }
    const personName = String(body.person_name ?? "").trim();
    if (!personName) throw new ApiError(400, "missing_name", "person_name 必填");
    if (personName.length > 60) throw new ApiError(400, "name_too_long", "姓名超长");

    const clues = Array.isArray(body.clues) ? body.clues : [];
    if (clues.length > CLUE_LIMITS.maxItems) {
      throw new ApiError(400, "too_many_clues", `身份线索最多 ${CLUE_LIMITS.maxItems} 项`);
    }
    const cleanClues = clues.map((c) => {
      const type = String(c?.type ?? "").trim();
      const value = String(c?.value ?? "").trim();
      if (!type || !value) throw new ApiError(400, "bad_clue", "线索需含 type 与 value");
      if (value.length > CLUE_LIMITS.maxValueLength) {
        throw new ApiError(400, "clue_too_long", "线索值超长");
      }
      return { type, value };
    });

    let estAge = body.est_age == null ? null : Number(body.est_age);
    if (estAge != null && (!Number.isInteger(estAge) || estAge < 0 || estAge > 120)) {
      throw new ApiError(400, "bad_age", "est_age 须为 0-120 的整数");
    }
    const ageBand = body.age_band ?? ageBandFor(estAge);

    const windows = Array.isArray(body.contact_windows) ? body.contact_windows : [];
    const cleanWindows = windows.map((w) => {
      const from = String(w?.from ?? "").trim();
      const to = String(w?.to ?? "").trim();
      const channel = String(w?.channel ?? "").trim();
      if (!from || !to || !channel) throw new ApiError(400, "bad_window", "联系时段需含 from/to/channel");
      return { from, to, channel };
    });

    const relationshipDecl = String(body.relationship_decl ?? "").trim().slice(0, 80);
    const lastContactPlace = String(body.last_contact_place ?? "").trim().slice(0, 120);
    const minorFlag = body.minor_flag === true || (estAge != null && estAge < 18) ? 1 : 0;

    return {
      side,
      personName,
      aliasName: String(body.alias_name ?? "").trim().slice(0, 60) || null,
      estAge,
      ageBand,
      gender: String(body.gender ?? "").trim().slice(0, 20) || null,
      minorFlag,
      clues: cleanClues,
      relationshipDecl,
      lastContactPlace,
      windows: cleanWindows,
    };
  }

  function insertReport(data, siteId, source) {
    const id = "R-" + randomUUID().slice(0, 12);
    db.prepare(
      `INSERT INTO reports (report_id, side, site_id, person_name, alias_name, est_age, age_band,
         gender, minor_flag, clues_json, relationship_decl, last_contact_place,
         contact_windows_json, evac_status, current_site_id, source_device_id, source_seq, created_at)
       VALUES (@report_id, @side, @site_id, @person_name, @alias_name, @est_age, @age_band,
         @gender, @minor_flag, @clues_json, @relationship_decl, @last_contact_place,
         @windows_json, @evac_status, @current_site_id, @device_id, @seq, @created_at)`
    ).run({
      report_id: id,
      side: data.side,
      site_id: siteId,
      person_name: data.personName,
      alias_name: data.aliasName,
      est_age: data.estAge,
      age_band: data.ageBand,
      gender: data.gender,
      minor_flag: data.minorFlag,
      clues_json: JSON.stringify(data.clues),
      relationship_decl: data.relationshipDecl,
      last_contact_place: data.lastContactPlace,
      windows_json: JSON.stringify(data.windows),
      evac_status: EvacStatus.ON_SITE,
      current_site_id: siteId,
      device_id: source?.deviceId ?? null,
      seq: source?.seq ?? null,
      created_at: nowIso(clock),
    });
    return q.report.get(id);
  }

  // ---------- 候选匹配（只生成候选，绝不合并报告） ----------

  function generateCandidatesFor(report) {
    const self = hydrate(report);
    const opposite = self.side === ReportSide.SEEKING ? ReportSide.LOCATED : ReportSide.SEEKING;
    const rows = db.prepare("SELECT * FROM reports WHERE side = ?").all(opposite);
    const created = [];
    const insert = db.prepare(
      `INSERT INTO match_candidates (candidate_id, seeking_report_id, located_report_id,
         score, confidence, factors_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const other of rows) {
      const s = self.side === ReportSide.SEEKING ? self : hydrate(other);
      const l = self.side === ReportSide.LOCATED ? self : hydrate(other);
      const result = scorePair(s, l);
      if (!result.confidence) continue;
      // 仅凭姓名相同：仍保留为低分候选供人工判断，但同名本身不得直接发起见面
      const candidateId = "C-" + randomUUID().slice(0, 12);
      insert.run(
        candidateId,
        s.report_id,
        l.report_id,
        result.score,
        result.confidence,
        JSON.stringify(result.factors),
        nowIso(clock)
      );
      created.push(candidateId);
    }
    return created;
  }

  function hydrate(row) {
    return { ...row, clues: JSON.parse(row.clues_json), contact_windows: JSON.parse(row.contact_windows_json) };
  }

  // ---------- 离线设备流水：重传幂等 ----------

  const sync = db.transaction((staffId, deviceId, seq, events) => {
    const staff = requireStaff(staffId, [Role.WORKER]);
    if (!deviceId || !Number.isInteger(seq) || seq < 1) {
      throw new ApiError(400, "bad_cursor", "device_id 与正整数 seq 必填");
    }
    if (!Array.isArray(events) || events.length === 0) {
      throw new ApiError(400, "empty_batch", "事件批次不能为空");
    }
    const payloadHash = createHash("sha256").update(JSON.stringify(events)).digest("hex");

    const existing = db.prepare("SELECT * FROM device_events WHERE device_id = ? AND seq = ?").get(deviceId, seq);
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new ApiError(409, "seq_payload_conflict", "同一流水号内容不一致，疑似编号冲突");
      }
      return { replayed: true, results: JSON.parse(existing.response_json) };
    }

    const cursor = db.prepare("SELECT * FROM device_cursor WHERE device_id = ?").get(deviceId);
    if (cursor && cursor.next_seq !== seq) {
      throw new ApiError(409, "out_of_order", `期望流水号 ${cursor.next_seq}，收到 ${seq}`);
    }
    if (!cursor && seq !== 1) {
      throw new ApiError(409, "out_of_order", `新设备首批必须从流水号 1 开始，收到 ${seq}`);
    }

    const results = [];
    for (const ev of events) {
      if (ev?.type === "register_report") {
        const data = validateReportBody(ev.report ?? {});
        const report = insertReport(data, staff.site_id, { deviceId, seq });
        const candidateIds = generateCandidatesFor(report);
        audit(staffId, "report_registered", "report", report.report_id, {
          device_id: deviceId,
          seq,
          candidate_count: candidateIds.length,
        });
        results.push({ type: "register_report", report_id: report.report_id, candidate_ids: candidateIds });
      } else {
        throw new ApiError(400, "unknown_event_type", `未知事件类型: ${ev?.type}`);
      }
    }

    db.prepare(
      `INSERT INTO device_events (device_id, seq, kind, payload_hash, response_json, created_at)
       VALUES (?, ?, 'sync', ?, ?, ?)`
    ).run(deviceId, seq, payloadHash, JSON.stringify(results), nowIso(clock));
    db.prepare(
      `INSERT INTO device_cursor (device_id, site_id, next_seq, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET next_seq = excluded.next_seq, updated_at = excluded.updated_at`
    ).run(deviceId, staff.site_id, seq + 1, nowIso(clock));

    return { replayed: false, results };
  });

  // 在线直登（安置点终端），同样触发候选生成
  function registerReport(staffId, body) {
    const staff = requireStaff(staffId, [Role.WORKER, Role.SPECIALIST]);
    const data = validateReportBody(body);
    const siteId = staff.role === Role.WORKER ? staff.site_id : body.site_id;
    if (!q.site.get(siteId)) throw new ApiError(400, "bad_site", "site_id 无效");
  return db.transaction(() => {
      const report = insertReport(data, siteId, null);
      const candidateIds = generateCandidatesFor(report);
      audit(staffId, "report_registered", "report", report.report_id, { candidate_count: candidateIds.length });
      return { report_id: report.report_id, candidate_ids: candidateIds };
    })();
  }

  // ---------- 脱敏候选视图 ----------

  function maskedReportView(report) {
    return {
      report_id: report.report_id,
      side: report.side,
      masked_name: maskName(report.person_name),
      age_band: report.age_band,
      gender: report.gender,
      minor: report.minor_flag === 1,
      relationship_decl: report.relationshipDecl ?? report.relationship_decl,
      masked_last_place: maskPlace(report.last_contact_place),
      contact_windows: maskWindows(report.contact_windows ?? JSON.parse(report.contact_windows_json)),
      site_id: report.site_id,
    };
  }

  function listCandidates(staffId) {
    const staff = requireStaff(staffId, [Role.WORKER]);
    const rows = db
      .prepare(
        `SELECT mc.* FROM match_candidates mc
           JOIN reports rs ON rs.report_id = mc.seeking_report_id
           JOIN reports rl ON rl.report_id = mc.located_report_id
          WHERE mc.status = 'open' AND (rs.site_id = ? OR rl.site_id = ?)
          ORDER BY mc.score DESC`
      )
      .all(staff.site_id, staff.site_id);
    audit(staffId, "candidate_list_viewed", "site", staff.site_id, { count: rows.length });
    return rows.map((c) => {
      const s = q.report.get(c.seeking_report_id);
      const l = q.report.get(c.located_report_id);
      return {
        candidate_id: c.candidate_id,
        score: c.score,
        confidence: c.confidence,
        factors: JSON.parse(c.factors_json), // 置信依据：因子名与分值，不含线索原值
        name_only: isNameOnly(JSON.parse(c.factors_json)),
        seeking: maskedReportView(s),
        located: maskedReportView(l),
      };
    });
  }

  // ---------- 限制与敏感情形 ----------

  function activeRestrictionFor(seekingId, locatedId, type) {
    return db
      .prepare(
        `SELECT * FROM restrictions WHERE active = 1 AND type = ? AND (
             (subject_report_id = ? AND (counterparty_report_id IS NULL OR counterparty_report_id = ?))
             OR (subject_report_id = ? AND (counterparty_report_id IS NULL OR counterparty_report_id = ?))
           ) LIMIT 1`
      )
      .get(type, seekingId, locatedId, locatedId, seekingId);
  }

  const addRestriction = db.transaction((staffId, body) => {
    const staff = requireStaff(staffId, [Role.SPECIALIST, Role.WORKER]);
    const type = body.type;
    if (![RestrictionType.CONTACT, RestrictionType.CUSTODY_DISPUTE].includes(type)) {
      throw new ApiError(400, "bad_restriction_type", "限制类型无效");
    }
    const subject = q.report.get(body.subject_report_id);
    if (!subject) throw new ApiError(404, "no_such_report", "主体登记不存在");
    let counterparty = null;
    if (body.counterparty_report_id) {
      counterparty = q.report.get(body.counterparty_report_id);
      if (!counterparty) throw new ApiError(404, "no_such_report", "相对方登记不存在");
    }
    const info = db
      .prepare(
        `INSERT INTO restrictions (subject_report_id, counterparty_report_id, type, detail, active, issued_by, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
      .run(subject.report_id, counterparty?.report_id ?? null, type, String(body.detail ?? "").slice(0, 300), staffId, nowIso(clock));
    audit(staffId, "restriction_added", "restriction", String(info.lastInsertRowid), {
      type,
      subject: subject.report_id,
      counterparty: counterparty?.report_id ?? null,
    });
    adjustForRestriction(subject.report_id, counterparty?.report_id ?? null, type, staffId);
    return { restriction_id: info.lastInsertRowid };
  });

  // 新限制到达：未完成安排转专门复核并作废凭据；已完成只追加风险说明
  function adjustForRestriction(subjectId, counterpartyId, type, staffId) {
    const linked = linkArrangements(subjectId, counterpartyId);
    for (const arr of linked) {
      if (arr.status === ArrangementStatus.COMPLETED) {
        appendRiskNote(arr.arrangement_id, "new_restriction", `团聚完成后新增限制：${type}`, staffId);
        continue;
      }
      if ([ArrangementStatus.PENDING, ArrangementStatus.APPROVED, ArrangementStatus.IN_REVIEW].includes(arr.status)) {
        if (arr.status === ArrangementStatus.APPROVED) voidCredentials(arr.arrangement_id, staffId, "new_restriction");
        // 保留最早的敏感情由（如 minor），新限制在审计与风险记录中体现
        const reason = arr.sensitive_reason ??
          (type === RestrictionType.CUSTODY_DISPUTE ? "custody_dispute" : "contact_restriction");
        db.prepare(
          "UPDATE arrangements SET status = 'in_review', sensitive_reason = ?, confirm_deadline = NULL, updated_at = ? WHERE arrangement_id = ?"
        ).run(reason, nowIso(clock), arr.arrangement_id);
        audit(staffId, "arrangement_rerouted_review", "arrangement", arr.arrangement_id, { reason: type });
      }
    }
  }

  // otherId 非空时，只返回同时涉及两人的安排（限制是双方之间的）；
  // 为空时返回涉及该人的全部安排（转移/状态更正/单方限制）。
  function linkArrangements(reportId, otherId = null) {
    const clauses = ["(seeking_report_id = ? OR located_report_id = ?)"];
    const params = [reportId, reportId];
    if (otherId) {
      clauses.push("(seeking_report_id = ? OR located_report_id = ?)");
      params.push(otherId, otherId);
    }
    return db.prepare(`SELECT * FROM arrangements WHERE ${clauses.join(" AND ")}`).all(...params);
  }

  function appendRiskNote(arrangementId, kind, note, staffId) {
    db.prepare(
      "INSERT INTO risk_notes (arrangement_id, kind, note, staff_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(arrangementId, kind, note, staffId, nowIso(clock));
    audit(staffId, "risk_note_appended", "arrangement", arrangementId, { kind });
  }

  // ---------- 发起安排：独占占用 + 分级路由 ----------

  const openArrangement = db.transaction((staffId, candidateId) => {
    const staff = requireStaff(staffId, [Role.WORKER]);
    const candidate = q.candidate.get(candidateId);
    if (!candidate) throw new ApiError(404, "no_such_candidate", "候选不存在");
    const seeking = q.report.get(candidate.seeking_report_id);
    const located = q.report.get(candidate.located_report_id);
    if (seeking.site_id !== staff.site_id && located.site_id !== staff.site_id) {
      throw new ApiError(403, "not_your_site", "只能为本安置点相关候选发起安排");
    }
    if (candidate.status !== "open") {
      throw new ApiError(409, "candidate_taken", "该候选已在处理或已关闭");
    }
    const factors = JSON.parse(candidate.factors_json);
    if (!hasStrongCorroboration(factors)) {
      throw new ApiError(422, "name_only_candidate", "姓名缺少强佐证（接触地点、共有身份线索或别名），不得仅凭同名安排见面");
    }

    const sensitive = seeking.minor_flag === 1 || located.minor_flag === 1
      ? "minor"
      : activeRestrictionFor(seeking.report_id, located.report_id, RestrictionType.CUSTODY_DISPUTE)
        ? "custody_dispute"
        : activeRestrictionFor(seeking.report_id, located.report_id, RestrictionType.CONTACT)
          ? "contact_restriction"
          : null;

    const id = "A-" + randomUUID().slice(0, 12);
    const ts = nowIso(clock);
    const status = sensitive ? ArrangementStatus.IN_REVIEW : ArrangementStatus.PENDING;
    const deadline = sensitive ? null : new Date(clock() + confirmTtl).toISOString();

    db.prepare(
      `INSERT INTO arrangements (arrangement_id, candidate_id, seeking_report_id, located_report_id,
         owning_site_id, status, sensitive_reason, created_at, updated_at, confirm_deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, candidateId, seeking.report_id, located.report_id, located.site_id, status, sensitive, ts, ts, deadline);

    // 独占占用：同一登记（同一人线索）只允许一处安排生效；冲突回滚整个事务
    try {
      const grant = db.prepare(
        "INSERT INTO active_claims (report_id, arrangement_id, granted_at) VALUES (?, ?, ?)"
      );
      grant.run(seeking.report_id, id, ts);
      grant.run(located.report_id, id, ts);
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) {
        throw new ApiError(409, "arrangement_active_elsewhere", "该登记已有一处生效中的安排，同一人只能一处生效");
      }
      throw err;
    }

    db.prepare("UPDATE match_candidates SET status = 'opened' WHERE candidate_id = ?").run(candidateId);
    audit(staffId, "arrangement_opened", "arrangement", id, { candidate_id: candidateId, sensitive });
    return { arrangement_id: id, status, sensitive_reason: sensitive, confirm_deadline: deadline };
  });

  // ---------- 确认 / 拒绝 / 复核 ----------

  function sweepTimeouts() {
    const ts = nowIso(clock);
    const stale = db
      .prepare(
        `SELECT * FROM arrangements
          WHERE (status = 'pending' AND confirm_deadline IS NOT NULL AND confirm_deadline < ?)
             OR (status = 'approved' AND credential_expires_at IS NOT NULL AND credential_expires_at < ?)`
      )
      .all(ts, ts);
    for (const arr of stale) releaseArrangement(arr, ReleaseReason.TIMEOUT, "system", ArrangementStatus.EXPIRED, "确认或会合超时");
  }

  // 释放占用但保留原申请（arrangement 行以终结状态留存，候选重新开放）
  function releaseArrangement(arr, reason, staffId, terminalStatus, note = "") {
    const tx = db.transaction(() => {
      db.prepare("UPDATE arrangements SET status = ?, release_reason = ?, confirm_deadline = NULL, updated_at = ? WHERE arrangement_id = ?")
        .run(terminalStatus, reason, nowIso(clock), arr.arrangement_id);
      db.prepare("DELETE FROM active_claims WHERE arrangement_id = ?").run(arr.arrangement_id);
      voidCredentials(arr.arrangement_id, staffId, reason);
      db.prepare("UPDATE match_candidates SET status = 'open' WHERE candidate_id = ?").run(arr.candidate_id);
      if (note) appendRiskNote(arr.arrangement_id, reason, note, staffId);
      audit(staffId, "arrangement_released", "arrangement", arr.arrangement_id, { reason, terminal_status: terminalStatus });
    });
    tx();
  }

  function sideSiteMatch(staff, side, seeking, located) {
    const report = side === ReportSide.SEEKING ? seeking : located;
    return staff.site_id === report.site_id;
  }

  const confirmSideTx = db.transaction((staffId, arrangementId, side) => {
    const staff = requireStaff(staffId, [Role.WORKER]);
    if (![ReportSide.SEEKING, ReportSide.LOCATED].includes(side)) {
      throw new ApiError(400, "bad_side", "side 必须是 seeking 或 located");
    }
    const arr = q.arrangement.get(arrangementId);
    if (!arr) throw new ApiError(404, "no_such_arrangement", "安排不存在");
    if (arr.status !== ArrangementStatus.PENDING) {
      throw new ApiError(409, "not_pending", "该安排不在待双方确认状态");
    }
    const seeking = q.report.get(arr.seeking_report_id);
    const located = q.report.get(arr.located_report_id);
    if (!sideSiteMatch(staff, side, seeking, located)) {
      throw new ApiError(403, "not_your_side", "只能由该方登记所在安置点的工作人员确认");
    }
    db.prepare(
      "INSERT OR IGNORE INTO arrangement_confirmations (arrangement_id, side, staff_id, at) VALUES (?, ?, ?, ?)"
    ).run(arrangementId, side, staffId, nowIso(clock));
    audit(staffId, "side_confirmed", "arrangement", arrangementId, { side });

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM arrangement_confirmations WHERE arrangement_id = ?")
      .get(arrangementId).n;
    if (count === 2) approveArrangement(arr, staffId);
    return arrangementView(arrangementId, staff);
  });

  // 超时扫描含独立事务，必须在确认事务之外完成，避免随后报错把释放回滚
  function confirmSide(staffId, arrangementId, side) {
    sweepTimeouts();
    return confirmSideTx(staffId, arrangementId, side);
  }

  const rejectSide = db.transaction((staffId, arrangementId, side, reason = "") => {
    const staff = requireStaff(staffId, [Role.WORKER, Role.SPECIALIST]);
    const arr = q.arrangement.get(arrangementId);
    if (!arr) throw new ApiError(404, "no_such_arrangement", "安排不存在");
    if ([ArrangementStatus.COMPLETED, ArrangementStatus.REJECTED, ArrangementStatus.RELEASED, ArrangementStatus.EXPIRED].includes(arr.status)) {
      throw new ApiError(409, "terminal", "该安排已终结");
    }
    if (staff.role === Role.WORKER) {
      const seeking = q.report.get(arr.seeking_report_id);
      const located = q.report.get(arr.located_report_id);
      if (!sideSiteMatch(staff, side, seeking, located)) {
        throw new ApiError(403, "not_your_side", "只能拒绝本安置点相关的一方");
      }
    }
    db.prepare(
      "UPDATE arrangements SET status = 'rejected', release_reason = 'rejected', updated_at = ? WHERE arrangement_id = ?"
    ).run(nowIso(clock), arrangementId);
    db.prepare("DELETE FROM active_claims WHERE arrangement_id = ?").run(arrangementId);
    db.prepare("UPDATE match_candidates SET status = 'open' WHERE candidate_id = ?").run(arr.candidate_id);
    if (reason) appendRiskNote(arrangementId, "rejected", String(reason).slice(0, 300), staffId);
    audit(staffId, "arrangement_rejected", "arrangement", arrangementId, { side });
    return { arrangement_id: arrangementId, status: ArrangementStatus.REJECTED };
  });

  const reviewArrangement = db.transaction((staffId, arrangementId, decision, note = "") => {
    const staff = requireStaff(staffId, [Role.SPECIALIST]);
    const arr = q.arrangement.get(arrangementId);
    if (!arr) throw new ApiError(404, "no_such_arrangement", "安排不存在");
    if (arr.status !== ArrangementStatus.IN_REVIEW) {
      throw new ApiError(409, "not_in_review", "该安排不在待复核队列");
    }
    db.prepare(
      "INSERT INTO arrangement_reviews (arrangement_id, reviewer_id, decision, note, at) VALUES (?, ?, ?, ?, ?)"
    ).run(arrangementId, staffId, decision, String(note).slice(0, 300), nowIso(clock));
    audit(staffId, "specialist_reviewed", "arrangement", arrangementId, { decision });
    if (decision === "reject") {
      db.prepare(
        "UPDATE arrangements SET status = 'rejected', release_reason = 'rejected', updated_at = ? WHERE arrangement_id = ?"
      ).run(nowIso(clock), arrangementId);
      db.prepare("DELETE FROM active_claims WHERE arrangement_id = ?").run(arrangementId);
      db.prepare("UPDATE match_candidates SET status = 'open' WHERE candidate_id = ?").run(arr.candidate_id);
      return { arrangement_id: arrangementId, status: ArrangementStatus.REJECTED };
    }
    if (decision !== "approve") throw new ApiError(400, "bad_decision", "decision 必须是 approve 或 reject");
    approveArrangement(arr, staffId);
    return arrangementView(arrangementId, staff);
  });

  function reviewQueue(staffId) {
    const staff = requireStaff(staffId, [Role.SPECIALIST]);
    audit(staffId, "review_queue_viewed", "arrangement", "");
    return listArrangementsByStatus(ArrangementStatus.IN_REVIEW).map((a) =>
      arrangementDetail(a, staff, { full: true })
    );
  }

  // --------— 凭据签发与会合完成 ----------

  function buildMeetingInfo(arr) {
    const seeking = hydrate(q.report.get(arr.seeking_report_id));
    const located = hydrate(q.report.get(arr.located_report_id));
    const site = q.site.get(arr.owning_site_id);
    const sWin = seeking.contact_windows[0] ?? null;
    const lWin = located.contact_windows[0] ?? null;
    const supervised = arr.sensitive_reason != null;
    return {
      meeting_site: site.name,
      meeting_point: supervised ? "服务台 supervised 接待区（须工作人员在场）" : "家属接待站",
      supervised,
      windows: { seeking: sWin, located: lWin },
      // 只披露会合必要信息：不含完整身份线索、不含完整名单
    };
  }

  function approveArrangement(arr, actorId) {
    const ts = nowIso(clock);
    const expires = new Date(clock() + credTtl).toISOString();
    const code = "M-" + randomBytes(5).toString("hex").toUpperCase();
    const meeting = buildMeetingInfo(arr);
    db.prepare(
      `INSERT INTO credentials (arrangement_id, code, meeting_info_json, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(arr.arrangement_id, code, JSON.stringify(meeting), ts, expires);
    db.prepare(
      "UPDATE arrangements SET status = 'approved', credential_expires_at = ?, updated_at = ? WHERE arrangement_id = ?"
    ).run(expires, ts, arr.arrangement_id);
    audit(actorId, "credential_issued", "arrangement", arr.arrangement_id, { expires_at: expires });
  }

  function voidCredentials(arrangementId, byStaffId, reason) {
    const rows = db.prepare("SELECT * FROM credentials WHERE arrangement_id = ? AND status = 'valid'").all(arrangementId);
    for (const c of rows) {
      db.prepare("UPDATE credentials SET status = 'void', voided_at = ? WHERE credential_id = ?").run(nowIso(clock), c.credential_id);
      audit(byStaffId, "credential_voided", "credential", String(c.credential_id), { reason });
    }
  }

  const completeArrangementTx = db.transaction((staffId, arrangementId) => {
    const staff = requireStaff(staffId, [Role.WORKER, Role.SPECIALIST]);
    const arr = q.arrangement.get(arrangementId);
    if (!arr) throw new ApiError(404, "no_such_arrangement", "安排不存在");
    if (arr.status !== ArrangementStatus.APPROVED) throw new ApiError(409, "not_approved", "只有已签发凭据的安排可登记团聚");
    if (staff.role === Role.WORKER && staff.site_id !== arr.owning_site_id) {
      throw new ApiError(403, "not_your_site", "只能由会合地点工作人员登记完成");
    }
    const confirmations = db
      .prepare("SELECT side, staff_id, at FROM arrangement_confirmations WHERE arrangement_id = ? ORDER BY at")
      .all(arrangementId);
    const reviews = db
      .prepare("SELECT reviewer_id, decision, note, at FROM arrangement_reviews WHERE arrangement_id = ? ORDER BY at")
      .all(arrangementId);
    const snapshot = {
      frozen_at: nowIso(clock),
      sensitive_reason: arr.sensitive_reason,
      confirmations,
      reviews,
      restrictions_active: db
        .prepare(
          `SELECT type, detail, issued_by, created_at FROM restrictions WHERE active = 1 AND
             (subject_report_id = ? OR subject_report_id = ? OR counterparty_report_id = ? OR counterparty_report_id = ?)`
        )
        .all(arr.seeking_report_id, arr.located_report_id, arr.seeking_report_id, arr.located_report_id),
    };
    db.prepare(
      "UPDATE arrangements SET status = 'completed', completed_at = ?, authorization_snapshot_json = ?, updated_at = ? WHERE arrangement_id = ?"
    ).run(nowIso(clock), JSON.stringify(snapshot), nowIso(clock), arrangementId);
    voidCredentials(arrangementId, staffId, "completed");
    audit(staffId, "reunion_completed", "arrangement", arrangementId, {});
    return { arrangement_id: arrangementId, status: ArrangementStatus.COMPLETED };
  });

  // 超时释放必须在完成事务之外，否则随后 409 会回滚凭据失效
  function completeArrangement(staffId, arrangementId) {
    sweepTimeouts();
    return completeArrangementTx(staffId, arrangementId);
  }

  function getCredential(staffId, arrangementId) {
    const staff = requireStaff(staffId, [Role.WORKER, Role.SPECIALIST]);
    sweepTimeouts();
    const arr = q.arrangement.get(arrangementId);
    if (!arr) throw new ApiError(404, "no_such_arrangement", "安排不存在");
    if (staff.role === Role.WORKER) {
      const seeking = q.report.get(arr.seeking_report_id);
      const located = q.report.get(arr.located_report_id);
      if (staff.site_id !== seeking.site_id && staff.site_id !== located.site_id) {
        throw new ApiError(403, "not_your_site", "无权查看该安排凭据");
      }
    }
    if (arr.status !== ArrangementStatus.APPROVED) throw new ApiError(409, "no_valid_credential", "当前没有有效凭据");
    const cred = db
      .prepare("SELECT * FROM credentials WHERE arrangement_id = ? AND status = 'valid' ORDER BY credential_id DESC LIMIT 1")
      .get(arrangementId);
    audit(staffId, "credential_viewed", "arrangement", arrangementId, { credential_id: cred.credential_id });
    return {
      code: cred.code,
      expires_at: cred.expires_at,
      meeting: JSON.parse(cred.meeting_info_json),
    };
  }

  // ---------- 安排视图 ----------

  function listArrangementsByStatus(status) {
    return db.prepare("SELECT * FROM arrangements WHERE status = ? ORDER BY updated_at").all(status);
  }

  function arrangementDetail(arr, staff, { full = false } = {}) {
    const seeking = q.report.get(arr.seeking_report_id);
    const located = q.report.get(arr.located_report_id);
    const confirmations = db
      .prepare("SELECT side, staff_id, at FROM arrangement_confirmations WHERE arrangement_id = ?")
      .all(arr.arrangement_id);
    return {
      arrangement_id: arr.arrangement_id,
      status: arr.status,
      owning_site_id: arr.owning_site_id,
      sensitive_reason: arr.sensitive_reason,
      release_reason: arr.release_reason,
      confirm_deadline: arr.confirm_deadline,
      credential_expires_at: arr.credential_expires_at,
      seeking: full && staff.role === Role.SPECIALIST ? fullReportView(seeking) : maskedReportView(seeking),
      located: full && staff.role === Role.SPECIALIST ? fullReportView(located) : maskedReportView(located),
      confirmed_sides: confirmations.map((c) => c.side),
    };
  }

  // 专门人员复核需要看到原值（访问本身写审计）
  function fullReportView(report) {
    const r = hydrate(report);
    return {
      report_id: r.report_id,
      side: r.side,
      person_name: r.person_name,
      alias_name: r.alias_name,
      est_age: r.est_age,
      age_band: r.age_band,
      gender: r.gender,
      minor: r.minor_flag === 1,
      clues: r.clues,
      relationship_decl: r.relationship_decl,
      last_contact_place: r.last_contact_place,
      contact_windows: r.contact_windows,
    };
  }

  function getArrangement(staffId, arrangementId) {
    const staff = requireStaff(staffId, [Role.WORKER, Role.SPECIALIST]);
    sweepTimeouts();
    const arr = q.arrangement.get(arrangementId);
    if (!arr) throw new ApiError(404, "no_such_arrangement", "安排不存在");
    if (staff.role === Role.WORKER) {
      const seeking = q.report.get(arr.seeking_report_id);
      const located = q.report.get(arr.located_report_id);
      if (staff.site_id !== seeking.site_id && staff.site_id !== located.site_id) {
        throw new ApiError(403, "not_your_site", "无权查看该安排");
      }
      audit(staffId, "arrangement_viewed", "arrangement", arrangementId, {});
      return arrangementDetail(arr, staff);
    }
    audit(staffId, "arrangement_viewed_full", "arrangement", arrangementId, {});
    return arrangementDetail(arr, staff, { full: true });
  }

  function arrangementView(arrangementId, staff) {
    return arrangementDetail(q.arrangement.get(arrangementId), staff);
  }

  function dismissCandidate(staffId, candidateId) {
    const staff = requireStaff(staffId, [Role.WORKER]);
    const candidate = q.candidate.get(candidateId);
    if (!candidate) throw new ApiError(404, "no_such_candidate", "候选不存在");
    const seeking = q.report.get(candidate.seeking_report_id);
    const located = q.report.get(candidate.located_report_id);
    if (staff.site_id !== seeking.site_id && staff.site_id !== located.site_id) {
      throw new ApiError(403, "not_your_site", "无权处理该候选");
    }
    if (candidate.status === "opened") throw new ApiError(409, "candidate_open_arrangement", "候选已有安排，请先终结安排");
    db.prepare("UPDATE match_candidates SET status = 'dismissed' WHERE candidate_id = ?").run(candidateId);
    audit(staffId, "candidate_dismissed", "candidate", candidateId, {});
    return { candidate_id: candidateId, status: "dismissed" };
  }

  // ---------- 转移 / 撤离状态更正 ----------

  function applyPersonChange(staffId, reportId, kind, payload) {
    const staff = requireStaff(staffId, [Role.WORKER, Role.SPECIALIST]);
    const report = q.report.get(reportId);
    if (!report) throw new ApiError(404, "no_such_report", "登记不存在");
    if (staff.role === Role.WORKER && staff.site_id !== report.site_id && staff.site_id !== report.current_site_id) {
      throw new ApiError(403, "not_your_site", "只能更新本点接收或登记的人员");
    }
    return db.transaction(() => {
      let noteText;
      if (kind === "transfer") {
        const dest = q.site.get(payload.to_site_id);
        if (!dest) throw new ApiError(400, "bad_site", "目标安置点无效");
        db.prepare(
          "UPDATE reports SET evac_status = ?, current_site_id = ?, version = version + 1 WHERE report_id = ?"
        ).run(EvacStatus.IN_TRANSIT, payload.to_site_id, reportId);
        noteText = `人员转移：目的地 ${dest.name}（${payload.to_site_id}）`;
      } else {
        const status = payload.evac_status;
        if (!Object.values(EvacStatus).includes(status)) throw new ApiError(400, "bad_evac_status", "撤离状态无效");
        let siteId = payload.current_site_id ?? null;
        if (siteId && !q.site.get(siteId)) throw new ApiError(400, "bad_site", "安置点无效");
        db.prepare(
          "UPDATE reports SET evac_status = ?, current_site_id = COALESCE(?, current_site_id), version = version + 1 WHERE report_id = ?"
        ).run(status, siteId, reportId);
        noteText = `撤离状态更正为 ${status}${siteId ? `（${siteId}）` : ""}`;
      }
      audit(staffId, kind === "transfer" ? "person_transferred" : "evac_status_corrected", "report", reportId, payload);

      for (const arr of linkArrangements(reportId, null)) {
        if (arr.status === ArrangementStatus.COMPLETED) {
          appendRiskNote(arr.arrangement_id, kind, `团聚完成后：${noteText}`, staffId);
        } else if ([ArrangementStatus.PENDING, ArrangementStatus.IN_REVIEW, ArrangementStatus.APPROVED].includes(arr.status)) {
          releaseArrangement(
            arr,
            kind === "transfer" ? ReleaseReason.TRANSFER : ReleaseReason.EVAC_CORRECTION,
            staffId,
            ArrangementStatus.RELEASED,
            noteText
          );
        }
      }
      return { report_id: reportId, version: report.version + 1 };
    })();
  }

  // ---------- 指挥席汇总 ----------

  function commandSummary(staffId) {
    const staff = requireStaff(staffId, [Role.COMMANDER]);
    sweepTimeouts();
    audit(staffId, "command_summary_viewed", "arrangement", "");
    const byStatus = {};
    for (const s of Object.values(ArrangementStatus)) byStatus[s] = 0;
    const blockers = {
      [BlockerReason.AWAITING_SIDE_CONFIRMATION]: 0,
      [BlockerReason.AWAITING_SPECIALIST_REVIEW]: 0,
      [BlockerReason.AWAITING_MEETING]: 0,
    };
    const blockList = [];
    for (const arr of db.prepare("SELECT * FROM arrangements").all()) {
      byStatus[arr.status]++;
      if (arr.status === ArrangementStatus.PENDING) {
        blockers[BlockerReason.AWAITING_SIDE_CONFIRMATION]++;
        const missing = 2 - db
          .prepare("SELECT COUNT(*) AS n FROM arrangement_confirmations WHERE arrangement_id = ?")
          .get(arr.arrangement_id).n;
        blockList.push({ arrangement_id: arr.arrangement_id, reason: BlockerReason.AWAITING_SIDE_CONFIRMATION, missing_confirmations: missing, deadline: arr.confirm_deadline });
      } else if (arr.status === ArrangementStatus.IN_REVIEW) {
        blockers[BlockerReason.AWAITING_SPECIALIST_REVIEW]++;
        blockList.push({ arrangement_id: arr.arrangement_id, reason: BlockerReason.AWAITING_SPECIALIST_REVIEW, sensitive_reason: arr.sensitive_reason });
      } else if (arr.status === ArrangementStatus.APPROVED) {
        blockers[BlockerReason.AWAITING_MEETING]++;
        blockList.push({ arrangement_id: arr.arrangement_id, reason: BlockerReason.AWAITING_MEETING, credential_expires_at: arr.credential_expires_at });
      }
    }
    const sites = db
      .prepare(
        `SELECT s.site_id, s.name,
           SUM(CASE WHEN r.side = 'seeking' THEN 1 ELSE 0 END) AS seeking,
           SUM(CASE WHEN r.side = 'located' THEN 1 ELSE 0 END) AS located
         FROM sites s LEFT JOIN reports r ON r.site_id = s.site_id GROUP BY s.site_id`
      )
      .all();
    return {
      totals: {
        reports: db.prepare("SELECT COUNT(*) AS n FROM reports").get().n,
        open_candidates: db.prepare("SELECT COUNT(*) AS n FROM match_candidates WHERE status = 'open'").get().n,
        active_restrictions: db.prepare("SELECT COUNT(*) AS n FROM restrictions WHERE active = 1").get().n,
      },
      arrangements: byStatus,
      blockers,
      blocked: blockList,
      sites: sites.map((s) => ({ site_id: s.site_id, name: s.name, seeking: s.seeking ?? 0, located: s.located ?? 0 })),
    };
  }

  // ---------- 审计重建（仅授权审计员） ----------

  function auditReconstruct(staffId, { arrangement_id, report_id } = {}) {
    const staff = requireStaff(staffId, [Role.AUDITOR]);
    let arrangementIds = [];
    let reportIds = [];
    if (arrangement_id) {
      const arr = q.arrangement.get(arrangement_id);
      if (!arr) throw new ApiError(404, "no_such_arrangement", "安排不存在");
      arrangementIds = [arrangement_id];
      reportIds = [arr.seeking_report_id, arr.located_report_id];
    } else if (report_id) {
      if (!q.report.get(report_id)) throw new ApiError(404, "no_such_report", "登记不存在");
      reportIds = [report_id];
      arrangementIds = db
        .prepare("SELECT arrangement_id FROM arrangements WHERE seeking_report_id = ? OR located_report_id = ?")
        .all(report_id, report_id)
        .map((r) => r.arrangement_id);
    } else {
      throw new ApiError(400, "missing_scope", "须提供 arrangement_id 或 report_id");
    }

    audit(staffId, "audit_reconstruction", "arrangement", arrangement_id ?? report_id, { report_ids: reportIds });

    const reports = reportIds.map((id) => {
      const r = hydrate(q.report.get(id));
      return {
        report_id: r.report_id,
        side: r.side,
        site_id: r.site_id,
        person_name: r.person_name,
        alias_name: r.alias_name,
        est_age: r.est_age,
        age_band: r.age_band,
        gender: r.gender,
        minor_flag: r.minor_flag,
        clues: r.clues, // 重建匹配所用线索原值
        relationship_decl: r.relationship_decl,
        last_contact_place: r.last_contact_place,
        contact_windows: r.contact_windows,
        evac_status: r.evac_status,
        version: r.version,
        created_at: r.created_at,
      };
    });

    const placeholders = (n) => (n ? Array(n).fill("?").join(",") : null);
    const rp = placeholders(reportIds.length);

    const candidateRows = db
      .prepare(
        `SELECT * FROM match_candidates WHERE seeking_report_id IN (${rp})
           OR located_report_id IN (${rp}) ORDER BY created_at`
      )
      .all(...reportIds, ...reportIds);
    const candidates = candidateRows
      // 按安排重建时只呈现该安排采用的候选；按登记重建时呈现全部候选
      .filter((c) => arrangement_id == null || c.candidate_id === q.arrangement.get(arrangement_id).candidate_id)
      .map((c) => ({
        candidate_id: c.candidate_id,
        seeking_report_id: c.seeking_report_id,
        located_report_id: c.located_report_id,
        score: c.score,
        confidence: c.confidence,
        factors: JSON.parse(c.factors_json),
        status: c.status,
        created_at: c.created_at,
      }));

    const arrangements = arrangementIds.map((id) => {
      const arr = q.arrangement.get(id);
      return {
        ...arr,
        confirmations: db.prepare("SELECT * FROM arrangement_confirmations WHERE arrangement_id = ?").all(id),
        reviews: db.prepare("SELECT * FROM arrangement_reviews WHERE arrangement_id = ?").all(id),
        credentials: db.prepare("SELECT credential_id, code, status, issued_at, expires_at, voided_at, meeting_info_json FROM credentials WHERE arrangement_id = ?").all(id),
        risk_notes: db.prepare("SELECT * FROM risk_notes WHERE arrangement_id = ? ORDER BY created_at").all(id),
        authorization_snapshot: arr.authorization_snapshot_json ? JSON.parse(arr.authorization_snapshot_json) : null,
      };
    });

    const restrictions = db
      .prepare(
        `SELECT * FROM restrictions WHERE subject_report_id IN (${rp})
           OR counterparty_report_id IN (${rp})`
      )
      .all(...reportIds, ...reportIds);

    // 敏感信息访问者：谁查看了全值/凭据，以及谁浏览过复核队列；
    // 按安排重建时只统计与这些安排相关的访问，避免夹带其他个案。
    const accessEvents = [
      ...db
        .prepare(
          `SELECT * FROM audit_events WHERE action IN
             ('arrangement_viewed_full','credential_viewed')
             AND entity_type = 'arrangement'
             AND entity_id IN (${placeholders(arrangementIds.length)}) ORDER BY at`
        )
        .all(...arrangementIds),
      ...db.prepare(`SELECT * FROM audit_events WHERE action = 'review_queue_viewed' ORDER BY at`).all(),
      ...db
        .prepare(
          `SELECT * FROM audit_events WHERE action = 'audit_reconstruction'
             AND entity_id = ? ORDER BY at`
        )
        .all(arrangement_id ?? report_id),
    ];

    // 最终确认过程时间线：与这些安排相关的全部审计事件
    const timeline = arrangementIds.length
      ? db
          .prepare(
            `SELECT * FROM audit_events WHERE entity_type = 'arrangement' AND entity_id IN
               (${placeholders(arrangementIds.length)}) ORDER BY audit_id`
          )
          .all(...arrangementIds)
      : [];

    return { reports, candidates, restrictions, arrangements, sensitive_access: accessEvents, timeline };
  }

  return {
    clock,
    sync,
    registerReport,
    listCandidates,
    dismissCandidate,
    openArrangement,
    confirmSide,
    rejectSide,
    reviewArrangement,
    reviewQueue,
    getArrangement,
    getCredential,
    completeArrangement,
    addRestriction,
    applyTransfer: (staffId, reportId, body) => applyPersonChange(staffId, reportId, "transfer", body),
    applyEvacCorrection: (staffId, reportId, body) => applyPersonChange(staffId, reportId, "correction", body),
    commandSummary,
    auditReconstruct,
    sweepTimeouts,
  };
}
