// 核心领域服务：登记、候选、团聚安排、凭据、状态联动、指挥汇总、审计重建。
import {
  PersonStatus, MATCHABLE_STATUSES, AgeBand, Restriction,
  CandidateStatus, ArrangementRoute, ArrangementState, ReleaseReason,
  DeviceEventType, DEFAULT_CONFIRM_TTL_MS, DEFAULT_RENDEZVOUS_TTL_MS,
} from "./contracts.js";
import { scoreCandidate } from "./matching.js";
import { candidateView } from "./masking.js";
import { appendAudit } from "./db.js";
import { nowIso, newId, randomToken, sha256, intersectWindows } from "./util.js";

const RELATIONSHIPS = new Set(["self", "parent", "child", "spouse", "sibling", "relative", "neighbor", "other"]);
const RESTRICTIONS = new Set(Object.values(Restriction));
const ACTIVE_STATES = new Set([ArrangementState.PENDING_REVIEW, ArrangementState.AWAITING_CONFIRMATIONS, ArrangementState.CONFIRMED]);

export class ServiceError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status; this.code = code; Object.assign(this, extra);
  }
}

function hydrateRegistration(r) {
  if (!r) return r;
  return {
    ...r,
    distinguishing_marks: JSON.parse(r.distinguishing_marks ?? "[]"),
    contact_windows: JSON.parse(r.contact_windows ?? "[]"),
    flags: JSON.parse(r.flags ?? "[]"),
  };
}

function inferAgeBand(approxAge, explicit) {
  if (explicit) return explicit;
  if (approxAge == null) return AgeBand.UNKNOWN;
  return Number(approxAge) < 18 ? AgeBand.CHILD : AgeBand.ADULT;
}

export function createService(db, {
  clock = () => Date.now(),
  confirmTtlMs = DEFAULT_CONFIRM_TTL_MS,
  rendezvousTtlMs = DEFAULT_RENDEZVOUS_TTL_MS,
} = {}) {
  const at = () => nowIso(clock());

  // ---------- 基础查询 ----------
  function getActor(actorId) {
    const actor = db.prepare("SELECT * FROM actors WHERE id = ?").get(actorId);
    if (!actor) throw new ServiceError(401, "unknown_actor", "未知的调用身份");
    return actor;
  }
  function requireRole(actor, ...roles) {
    if (!roles.includes(actor.role)) throw new ServiceError(403, "forbidden_role", "该角色无权执行此操作");
  }
  function getSite(id) {
    return db.prepare("SELECT * FROM sites WHERE id = ?").get(id);
  }
  function getReg(id) {
    return hydrateRegistration(db.prepare("SELECT * FROM registrations WHERE id = ?").get(id));
  }
  function getRegOr404(id) {
    const reg = getReg(id);
    if (!reg) throw new ServiceError(404, "registration_not_found", "登记不存在");
    return reg;
  }
  function getCandidate(id) {
    const c = db.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
    if (!c) throw new ServiceError(404, "candidate_not_found", "候选不存在");
    return { ...c, basis: JSON.parse(c.basis), route_reasons: undefined };
  }
  function candidatePair(c) {
    const a = getReg(c.registration_a);
    const b = getReg(c.registration_b);
    const sa = getSite(a.registering_site_id);
    const sb = getSite(b.registering_site_id);
    return { regA: a, regB: b, siteNameA: sa?.name ?? a.registering_site_id, siteNameB: sb?.name ?? b.registering_site_id };
  }
  function getArrangement(id) {
    const x = db.prepare("SELECT * FROM arrangements WHERE id = ?").get(id);
    if (!x) throw new ServiceError(404, "arrangement_not_found", "安排不存在");
    return { ...x, route_reasons: JSON.parse(x.route_reasons ?? "[]"), rendezvous_plan: x.rendezvous_plan ? JSON.parse(x.rendezvous_plan) : null };
  }
  function addEvent(arrangementId, type, actorId, detail = {}) {
    db.prepare("INSERT INTO arrangement_events (id, arrangement_id, at, type, actor_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId(), arrangementId, at(), type, actorId, JSON.stringify(detail));
  }
  function touch(id) {
    db.prepare("UPDATE arrangements SET updated_at = ? WHERE id = ?").run(at(), id);
  }

  // ---------- 登记校验 ----------
  function validateRegistration(input) {
    const p = input ?? {};
    if (!p.person_name || String(p.person_name).trim().length < 2) {
      throw new ServiceError(400, "invalid_name", "person_name 至少 2 个字符");
    }
    const reportKind = p.report_kind === "found" ? "found" : "seek";
    const relationship = p.relationship ?? "other";
    if (!RELATIONSHIPS.has(relationship)) throw new ServiceError(400, "invalid_relationship", "未知关系类别");
    const approxAge = p.approx_age == null ? null : Number(p.approx_age);
    if (approxAge != null && (!Number.isFinite(approxAge) || approxAge < 0 || approxAge > 120)) {
      throw new ServiceError(400, "invalid_age", "approx_age 无效");
    }
    const ageBand = inferAgeBand(approxAge, p.age_band);
    const marks = Array.isArray(p.distinguishing_marks) ? p.distinguishing_marks.slice(0, 3).map((m) => String(m).trim()).filter(Boolean) : [];
    const windows = Array.isArray(p.contact_windows) ? p.contact_windows : [];
    for (const w of windows) {
      if (!w || !Date.parse(w.from) || !Date.parse(w.to) || Date.parse(w.from) >= Date.parse(w.to)) {
        throw new ServiceError(400, "invalid_window", "contact_windows 须含合法的 from/to");
      }
    }
    if (!p.last_contact_place || String(p.last_contact_place).trim().length < 2) {
      throw new ServiceError(400, "invalid_place", "last_contact_place 必填");
    }
    const flags = Array.from(new Set(Array.isArray(p.flags) ? p.flags : [])).filter((f) => RESTRICTIONS.has(f));
    if (!p.registering_site_id || !getSite(p.registering_site_id)) {
      throw new ServiceError(400, "invalid_site", "registering_site_id 无效");
    }
    if (!p.reporter_name || String(p.reporter_name).trim().length < 2) {
      throw new ServiceError(400, "invalid_reporter", "reporter_name 必填");
    }
    return {
      report_kind: reportKind,
      person_name: String(p.person_name).trim(),
      approx_age: approxAge,
      age_band: ageBand,
      distinguishing_marks: marks,
      relationship,
      relationship_detail: p.relationship_detail ? String(p.relationship_detail).slice(0, 120) : null,
      reporter_name: String(p.reporter_name).trim(),
      contact_phone: p.contact_phone ? String(p.contact_phone).slice(0, 32) : null,
      contact_windows: windows.map((w) => ({ from: w.from, to: w.to })),
      last_contact_place: String(p.last_contact_place).trim(),
      last_contact_at: p.last_contact_at ?? null,
      flags,
      registering_site_id: p.registering_site_id,
    };
  }

  function insertRegistration(data, actorId) {
    const id = newId();
    db.prepare(
      `INSERT INTO registrations (id, report_kind, person_name, approx_age, age_band, distinguishing_marks,
        relationship, relationship_detail, reporter_name, contact_phone, contact_windows,
        last_contact_place, last_contact_at, flags, subject_status, subject_site_id,
        registering_site_id, created_at, updated_at)
       VALUES (@id, @report_kind, @person_name, @approx_age, @age_band, @distinguishing_marks,
        @relationship, @relationship_detail, @reporter_name, @contact_phone, @contact_windows,
        @last_contact_place, @last_contact_at, @flags, 'missing', @subject_site_id,
        @registering_site_id, @ts, @ts)`
    ).run({
      id,
      ...data,
      distinguishing_marks: JSON.stringify(data.distinguishing_marks),
      contact_windows: JSON.stringify(data.contact_windows),
      flags: JSON.stringify(data.flags),
      subject_site_id: data.registering_site_id,
      ts: at(),
    });
    const reg = getReg(id);
    appendAudit(db, { actorId, action: "registration_created", entityType: "registration", entityId: id,
      detail: { site: data.registering_site_id, report_kind: data.report_kind, relationship: data.relationship,
        age_band: data.age_band, flags: data.flags, has_phone: Boolean(data.contact_phone), marks_count: data.distinguishing_marks.length } });
    return reg;
  }

  /** 新登记入库后，与全部可匹配登记交叉打分，落候选（不自动合并） */
  function generateCandidates(reg, actorId) {
    const others = db.prepare("SELECT * FROM registrations WHERE id != ?").all(reg.id).map(hydrateRegistration);
    const created = [];
    for (const other of others) {
      if (![reg, other].every((x) => MATCHABLE_STATUSES.includes(x.subject_status))) continue;
      const result = scoreCandidate(reg, other);
      if (!result) continue;
      const [a, b] = reg.id < other.id ? [reg.id, other.id] : [other.id, reg.id];
      const exists = db.prepare("SELECT id FROM candidates WHERE registration_a = ? AND registration_b = ?").get(a, b);
      if (exists) continue;
      const id = newId();
      db.prepare(
        `INSERT INTO candidates (id, registration_a, registration_b, score, confidence, basis, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`
      ).run(id, a, b, result.score, result.confidence, JSON.stringify(result.basis), at(), at());
      appendAudit(db, { actorId, action: "candidate_proposed", entityType: "candidate", entityId: id,
        detail: { registration_a: a, registration_b: b, score: result.score, confidence: result.confidence, basis: result.basis.map((x) => x.clue) } });
      created.push(id);
    }
    return created;
  }

  // ---------- 离线设备流水（重传幂等） ----------
  function ingestDeviceEvent(actor, { device_id, seq, type, payload }) {
    if (!device_id || !Number.isInteger(seq) || seq < 0) {
      throw new ServiceError(400, "invalid_device_cursor", "device_id 与非负整数 seq 必填");
    }
    if (!Object.values(DeviceEventType).includes(type)) {
      throw new ServiceError(400, "invalid_event_type", "未知流水事件类型");
    }
    const existing = db.prepare("SELECT * FROM device_events WHERE device_id = ? AND seq = ?").get(device_id, seq);
    if (existing) {
      return { duplicate: true, applied: Boolean(existing.applied), type: existing.type, registration_id: existing.registration_id ?? undefined };
    }

    const eventId = newId();
    let registrationId = null;
    const apply = db.transaction(() => {
      db.prepare(
        `INSERT INTO device_events (id, device_id, seq, type, payload, received_at, applied) VALUES (?, ?, ?, ?, ?, ?, 0)`
      ).run(eventId, device_id, seq, type, JSON.stringify(payload ?? {}), at());

      if (type === DeviceEventType.REGISTRATION) {
        const data = validateRegistration({ ...payload, registering_site_id: payload?.registering_site_id ?? actor.site_id });
        if (actor.site_id && data.registering_site_id !== actor.site_id) {
          throw new ServiceError(403, "site_mismatch", "设备只能登记本安置点人员");
        }
        const reg = insertRegistration(data, actor.id);
        generateCandidates(reg, actor.id);
        registrationId = reg.id;
      } else if (type === DeviceEventType.TRANSFER) {
        applyTransfer(actor.id, payload.registration_id, payload.to_site_id);
      } else if (type === DeviceEventType.STATUS_CORRECTION) {
        applyStatusCorrection(actor.id, payload.registration_id, payload.status, payload.note);
      } else if (type === DeviceEventType.RESTRICTION) {
        applyRestriction(actor.id, payload.registration_id, payload.flag, payload.note);
      }
      db.prepare("UPDATE device_events SET applied = 1, registration_id = ? WHERE id = ?").run(registrationId, eventId);
      appendAudit(db, { actorId: actor.id, action: "device_event_applied", entityType: "device_event", entityId: eventId,
        detail: { device_id, seq, type, registration_id: registrationId } });
    });
    apply();
    return { duplicate: false, applied: true, type, registration_id: registrationId ?? undefined, event_id: eventId };
  }

  // ---------- 候选可见性 ----------
  function listCandidatesForWorker(actor) {
    sweepExpired(actor.id);
    const rows = db.prepare("SELECT * FROM candidates ORDER BY score DESC, created_at ASC").all();
    const out = [];
    for (const c of rows) {
      const pair = candidatePair(c);
      const involved = [pair.regA, pair.regB].some(
        (r) => r.registering_site_id === actor.site_id || r.subject_site_id === actor.site_id
      );
      if (!involved) continue;
      const side = pair.regA.registering_site_id === actor.site_id || pair.regA.subject_site_id === actor.site_id ? "a" : "b";
      out.push(candidateView({ candidate: { ...c, basis: JSON.parse(c.basis) }, ...pair, viewerSide: side }));
    }
    return out;
  }

  function viewCandidate(actor, candidateId) {
    const c = getCandidate(candidateId);
    const pair = candidatePair(c);
    if (actor.role === "worker") {
      const onA = pair.regA.registering_site_id === actor.site_id || pair.regA.subject_site_id === actor.site_id;
      const onB = pair.regB.registering_site_id === actor.site_id || pair.regB.subject_site_id === actor.site_id;
      if (!onA && !onB) throw new ServiceError(403, "not_your_site", "只能查看本安置点相关候选");
      return candidateView({ candidate: c, ...pair, viewerSide: onA ? "a" : "b" });
    }
    if (actor.role === "specialist") {
      return candidateView({ candidate: c, ...pair, viewerSide: null });
    }
    throw new ServiceError(403, "forbidden_role", "该角色无权查看候选");
  }

  // ---------- 路由 ----------
  function routeFor(regA, regB) {
    const reasons = new Set();
    for (const r of [regA, regB]) {
      if (r.age_band === AgeBand.CHILD) reasons.add("minor");
      if (r.flags.includes(Restriction.CUSTODY_DISPUTE)) reasons.add(Restriction.CUSTODY_DISPUTE);
      if (r.flags.includes(Restriction.RESTRICTED_CONTACT)) reasons.add(Restriction.RESTRICTED_CONTACT);
      if (r.relationship === "neighbor" && r.age_band === AgeBand.CHILD) reasons.add("neighbor_care");
    }
    return reasons.size > 0
      ? { route: ArrangementRoute.SPECIALIST_REVIEW, reasons: [...reasons] }
      : { route: ArrangementRoute.MUTUAL_CONFIRM, reasons: [] };
  }

  function activeArrangementsForReg(regId) {
    return db.prepare(
      `SELECT * FROM arrangements WHERE state IN ('pending_review','awaiting_confirmations','confirmed')
       AND (side_a_registration_id = ? OR side_b_registration_id = ?)`
    ).all(regId, regId);
  }

  function startArrangement(actor, candidateId) {
    requireRole(actor, "worker");
    const c = getCandidate(candidateId);
    const pair = candidatePair(c);
    const involved = [pair.regA, pair.regB].some(
      (r) => r.registering_site_id === actor.site_id || r.subject_site_id === actor.site_id
    );
    if (!involved) throw new ServiceError(403, "not_your_site", "只能对本点候选发起安排");
    if (c.status === CandidateStatus.CONFIRMED) {
      throw new ServiceError(409, "candidate_consumed", "该候选已完成团聚", { candidate_status: c.status });
    }
    if (c.status === CandidateStatus.SUPERSEDED) {
      throw new ServiceError(409, "candidate_superseded", "该候选依据已失效（状态更正或当事人已在他处团聚）", { candidate_status: c.status });
    }
    if (c.active_arrangement_id) {
      const current = db.prepare("SELECT state FROM arrangements WHERE id = ?").get(c.active_arrangement_id);
      if (current && ACTIVE_STATES.has(current.state)) {
        throw new ServiceError(409, "candidate_not_open", "该候选已有进行中安排", { arrangement_id: c.active_arrangement_id, arrangement_state: current.state });
      }
      db.prepare("UPDATE candidates SET active_arrangement_id = NULL WHERE id = ?").run(c.id);
    }
    for (const r of [pair.regA, pair.regB]) {
      if (!MATCHABLE_STATUSES.includes(r.subject_status)) {
        throw new ServiceError(409, "subject_not_matchable", "当事人当前状态不允许安排团聚", { registration_id: r.id, status: r.subject_status });
      }
    }
    for (const r of [pair.regA, pair.regB]) {
      // 已完成团聚者不再发起新安排；多个待确认安排允许并行（完成时单赢裁决）
      const won = activeArrangementsForReg(r.id).find((x) => x.state === ArrangementState.CONFIRMED);
      if (won) {
        throw new ServiceError(409, "already_reunited", "该人员已有生效团聚安排", { arrangement_id: won.id });
      }
    }
    const { route, reasons } = routeFor(pair.regA, pair.regB);
    const id = newId();
    const state = route === ArrangementRoute.SPECIALIST_REVIEW
      ? ArrangementState.PENDING_REVIEW
      : ArrangementState.AWAITING_CONFIRMATIONS;
    db.prepare(
      `INSERT INTO arrangements (id, candidate_id, route, state, route_reasons,
        side_a_registration_id, side_b_registration_id, confirm_deadline, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, c.id, route, state, JSON.stringify(reasons), pair.regA.id, pair.regB.id,
      route === ArrangementRoute.MUTUAL_CONFIRM ? new Date(clock() + confirmTtlMs).toISOString() : null, at(), at());
    db.prepare("UPDATE candidates SET active_arrangement_id = ?, updated_at = ? WHERE id = ?").run(id, at(), c.id);
    addEvent(id, "created", actor.id, { route, reasons });
    appendAudit(db, { actorId: actor.id, action: "arrangement_started", entityType: "arrangement", entityId: id,
      detail: { candidate_id: c.id, route, reasons } });
    return getArrangement(id);
  }

  // ---------- 双方分别确认（短期凭据） ----------
  function issueConfirmationToken(actor, arrangementId, side) {
    requireRole(actor, "worker");
    if (side !== "a" && side !== "b") throw new ServiceError(400, "invalid_side", "side 须为 a/b");
    const x = getArrangement(arrangementId);
    if (x.state !== ArrangementState.AWAITING_CONFIRMATIONS) {
      throw new ServiceError(409, "not_awaiting_confirmation", "当前状态不可发放确认凭据", { state: x.state });
    }
    const reg = side === "a" ? getReg(x.side_a_registration_id) : getReg(x.side_b_registration_id);
    if (reg.registering_site_id !== actor.site_id && reg.subject_site_id !== actor.site_id) {
      throw new ServiceError(403, "not_your_side", "只能向本点一方发放凭据");
    }
    const token = randomToken();
    const stored = `${x.token_epoch}:${sha256(token)}`;
    const col = side === "a" ? "token_a_hash" : "token_b_hash";
    const issuedCol = side === "a" ? "token_a_issued_at" : "token_b_issued_at";
    db.prepare(`UPDATE arrangements SET ${col} = ?, ${issuedCol} = ?, updated_at = ? WHERE id = ?`)
      .run(stored, at(), at(), x.id);
    addEvent(x.id, "confirmation_token_issued", actor.id, { side });
    appendAudit(db, { actorId: actor.id, action: "confirmation_token_issued", entityType: "arrangement", entityId: x.id, detail: { side } });
    return { side, token, expires_at: x.confirm_deadline };
  }

  function findArrangementByToken(token) {
    const rows = db.prepare("SELECT * FROM arrangements").all();
    for (const row of rows) {
      for (const col of ["token_a_hash", "token_b_hash"]) {
        if (row[col]?.split(":")[1] === sha256(token)) return { row, side: col === "token_a_hash" ? "a" : "b" };
      }
    }
    return null;
  }

  function findConfirmedConflict(arr) {
    return db.prepare(
      `SELECT * FROM arrangements WHERE state = 'confirmed' AND id != ?
       AND (side_a_registration_id IN (?, ?) OR side_b_registration_id IN (?, ?))
       ORDER BY completed_at ASC LIMIT 1`
    ).get(arr.id, arr.side_a_registration_id, arr.side_b_registration_id, arr.side_a_registration_id, arr.side_b_registration_id);
  }

  function buildRendezvousPlan(arr) {
    const regA = getReg(arr.side_a_registration_id);
    const regB = getReg(arr.side_b_registration_id);
    const foundSide = [regA, regB].find((r) => r.report_kind === "found");
    const holder = foundSide ?? regB;
    const siteId = holder.subject_site_id ?? holder.registering_site_id;
    const site = getSite(siteId);
    return {
      site_id: siteId,
      site_name: site?.name ?? siteId,
      contact_windows: intersectWindows(regA.contact_windows, regB.contact_windows),
      supervised: [regA, regB].some((r) => r.flags.includes(Restriction.RESTRICTED_CONTACT)),
      holder_side: foundSide ? (foundSide.id === regA.id ? "a" : "b") : "b",
    };
  }

  function finalizeConfirmed(arr, actorId) {
    const plan = buildRendezvousPlan(arr);
    const rvToken = randomToken();
    db.prepare(
      `UPDATE arrangements SET state = 'confirmed', winning_site_id = ?, rendezvous_plan = ?,
        rendezvous_token_hash = ?, rendezvous_expires_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`
    ).run(plan.site_id, JSON.stringify(plan), sha256(rvToken),
      new Date(clock() + rendezvousTtlMs).toISOString(), at(), at(), arr.id);
    db.prepare("UPDATE candidates SET status = 'confirmed', updated_at = ? WHERE id = ?").run(at(), arr.candidate_id);
    addEvent(arr.id, "confirmed", actorId, { winning_site_id: plan.site_id, supervised: plan.supervised });
    appendAudit(db, { actorId, action: "reunion_confirmed", entityType: "arrangement", entityId: arr.id,
      detail: { candidate_id: arr.candidate_id, winning_site_id: plan.site_id, supervised: plan.supervised,
        windows: plan.contact_windows.length } });
    return rvToken;
  }

  function confirmByToken(token) {
    if (!token) throw new ServiceError(400, "missing_token", "缺少确认凭据");
    const hit = findArrangementByToken(token);
    if (!hit) throw new ServiceError(404, "invalid_token", "凭据无效或已撤销");
    const { row, side } = hit;
    const arr = getArrangement(row.id);
    const epoch = Number(row[side === "a" ? "token_a_hash" : "token_b_hash"].split(":")[0]);
    if (epoch !== arr.token_epoch) throw new ServiceError(409, "token_superseded", "安排已调整，凭据已失效，请重新领取");
    if (arr.state !== ArrangementState.AWAITING_CONFIRMATIONS) {
      throw new ServiceError(409, "arrangement_not_open", "安排当前不接受确认", { state: arr.state });
    }
    if (Date.parse(arr.confirm_deadline) < clock()) {
      releaseArrangement(arr, ReleaseReason.TIMEOUT, null, "确认超时");
      throw new ServiceError(409, "confirmation_expired", "确认凭据已超时，安排已释放");
    }
    const already = side === "a" ? arr.confirmed_a_at : arr.confirmed_b_at;
    const tx = db.transaction(() => {
      if (!already) {
        const col = side === "a" ? "confirmed_a_at" : "confirmed_b_at";
        db.prepare(`UPDATE arrangements SET ${col} = ?, updated_at = ? WHERE id = ?`).run(at(), at(), arr.id);
        addEvent(arr.id, "party_confirmed", null, { side });
        appendAudit(db, { actorId: null, action: "party_confirmed", entityType: "arrangement", entityId: arr.id, detail: { side } });
      }
      const fresh = getArrangement(arr.id);
      if (fresh.confirmed_a_at && fresh.confirmed_b_at) {
        // 单赢：两个地点不能同时生效
        const conflict = findConfirmedConflict(fresh);
        if (conflict) {
          releaseArrangement(fresh, ReleaseReason.CONFLICT_LOST, null, `另一地点安排 ${conflict.id} 已先生效`);
          return { outcome: "conflict_lost", arrangement_id: arr.id };
        }
        const rvToken = finalizeConfirmed(fresh, null);
        const done = getArrangement(fresh.id);
        return { outcome: "confirmed", arrangement_id: arr.id, rendezvous_token: rvToken, rendezvous_expires_at: done.rendezvous_expires_at };
      }
      return { outcome: "waiting", arrangement_id: arr.id, confirmed: { a: Boolean(fresh.confirmed_a_at), b: Boolean(fresh.confirmed_b_at) } };
    });
    return tx();
  }

  function declineArrangement(actor, arrangementId, side, reason) {
    requireRole(actor, "worker");
    if (side !== "a" && side !== "b") throw new ServiceError(400, "invalid_side", "side 须为 a/b");
    const arr = getArrangement(arrangementId);
    if (arr.state !== ArrangementState.AWAITING_CONFIRMATIONS) {
      throw new ServiceError(409, "arrangement_not_open", "仅待确认安排可拒绝", { state: arr.state });
    }
    const reg = side === "a" ? getReg(arr.side_a_registration_id) : getReg(arr.side_b_registration_id);
    if (reg.registering_site_id !== actor.site_id && reg.subject_site_id !== actor.site_id) {
      throw new ServiceError(403, "not_your_side", "只能代表本点一方拒绝");
    }
    releaseArrangement(arr, ReleaseReason.DECLINED, actor.id, reason ?? `一方（${side}）拒绝`, { side });
    return getArrangement(arr.id);
  }

  function releaseArrangement(arr, reason, actorId, note, extra = {}) {
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE arrangements SET state = 'released', release_reason = ?, released_at = ?, updated_at = ?, token_epoch = token_epoch + 1 WHERE id = ?`
      ).run(reason, at(), at(), arr.id);
      // 冲突失败 / 状态更正：候选失效；超时 / 拒绝：候选回到 proposed 以便重新发起
      const candidateStatus = reason === ReleaseReason.CONFLICT_LOST ? "superseded" : "proposed";
      db.prepare("UPDATE candidates SET active_arrangement_id = NULL, status = ?, updated_at = ? WHERE id = ?")
        .run(candidateStatus, at(), arr.candidate_id);
      addEvent(arr.id, "released", actorId, { reason, note, ...extra });
      appendAudit(db, { actorId, action: "arrangement_released", entityType: "arrangement", entityId: arr.id,
        detail: { reason, note, ...extra } });
    })();
  }

  // ---------- 专门复核 ----------
  function reviewQueue() {
    return db.prepare("SELECT * FROM arrangements WHERE state = 'pending_review' ORDER BY created_at ASC").all().map((x) => ({
      id: x.id, candidate_id: x.candidate_id, route: x.route,
      route_reasons: JSON.parse(x.route_reasons), created_at: x.created_at,
    }));
  }

  function reviewDetail(actor, arrangementId, full) {
    const x = getArrangement(arrangementId);
    if (x.state !== ArrangementState.PENDING_REVIEW && !full) {
      throw new ServiceError(409, "not_in_review", "该安排不在复核队列", { state: x.state });
    }
    const c = getCandidate(x.candidate_id);
    const pair = candidatePair(c);
    const view = candidateView({ candidate: c, ...pair, viewerSide: null });
    if (full) {
      // 解开脱敏：每次访问敏感信息都留痕
      view.sides.a.registration = { ...pair.regA };
      view.sides.b.registration = { ...pair.regB };
      view.basis = c.basis;
      appendAudit(db, { actorId: actor.id, action: "sensitive_access", entityType: "arrangement", entityId: x.id,
        detail: { reason: "specialist_review_full", fields: ["person_name", "reporter_name", "contact_phone", "relationship_detail", "marks"] } });
    }
    return { arrangement: x, candidate: view };
  }

  function specialistDecision(actor, arrangementId, decision, note) {
    if (decision !== "approved" && decision !== "rejected") {
      throw new ServiceError(400, "invalid_decision", "decision 须为 approved/rejected");
    }
    const arr = getArrangement(arrangementId);
    if (arr.state !== ArrangementState.PENDING_REVIEW) {
      throw new ServiceError(409, "not_in_review", "该安排不在复核队列", { state: arr.state });
    }
    if (decision === "rejected") {
      db.prepare("UPDATE arrangements SET state = 'rejected', release_reason = 'review_rejected', specialist_id = ?, review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
        .run(actor.id, note ?? null, at(), at(), arr.id);
      db.prepare("UPDATE candidates SET active_arrangement_id = NULL, status = 'superseded', updated_at = ? WHERE id = ?").run(at(), arr.candidate_id);
      addEvent(arr.id, "review_rejected", actor.id, { note });
      appendAudit(db, { actorId: actor.id, action: "review_rejected", entityType: "arrangement", entityId: arr.id, detail: { note } });
    } else {
      const conflict = findConfirmedConflict(arr);
      if (conflict) {
        releaseArrangement(arr, ReleaseReason.CONFLICT_LOST, actor.id, `另一地点安排 ${conflict.id} 已先生效`);
        throw new ServiceError(409, "conflict_lost", "另一地点已完成同一人团聚，本安排释放", { winner: conflict.id });
      }
      const tx = db.transaction(() => {
        db.prepare("UPDATE arrangements SET specialist_id = ?, review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
          .run(actor.id, note ?? null, at(), at(), arr.id);
        addEvent(arr.id, "review_approved", actor.id, { note });
        const rvToken = finalizeConfirmed(getArrangement(arr.id), actor.id);
        return rvToken;
      })();
      return { outcome: "confirmed", arrangement_id: arr.id, rendezvous_token: tx, rendezvous_expires_at: getArrangement(arr.id).rendezvous_expires_at };
    }
    return { outcome: "rejected", arrangement_id: arr.id };
  }

  // ---------- 会合凭据 ----------
  function rendezvousByToken(token) {
    if (!token) throw new ServiceError(400, "missing_token", "缺少会合凭据");
    const row = db.prepare("SELECT * FROM arrangements WHERE rendezvous_token_hash = ? AND state = 'confirmed'").get(sha256(token));
    if (!row) throw new ServiceError(404, "invalid_token", "会合凭据无效");
    if (Date.parse(row.rendezvous_expires_at) < clock()) {
      throw new ServiceError(409, "rendezvous_expired", "会合凭据已过期，请联系工作人员换发");
    }
    const plan = JSON.parse(row.rendezvous_plan);
    // 会合点保留生效时授权；但确认后到达的限制接触需即时提示监督
    const currentFlags = [row.side_a_registration_id, row.side_b_registration_id]
      .flatMap((id) => getReg(id)?.flags ?? []);
    const supervisedNow = plan.supervised || currentFlags.includes(Restriction.RESTRICTED_CONTACT);
    appendAudit(db, { actorId: null, action: "rendezvous_accessed", entityType: "arrangement", entityId: row.id, detail: { supervised: supervisedNow } });
    // 只披露会合必要信息：地点与可联系时段交集
    return { site_name: plan.site_name, supervised: supervisedNow, contact_windows: plan.contact_windows, expires_at: row.rendezvous_expires_at };
  }

  function reissueRendezvous(actor, arrangementId) {
    const arr = getArrangement(arrangementId);
    if (arr.state !== ArrangementState.CONFIRMED) throw new ServiceError(409, "not_confirmed", "仅已确认安排可换发");
    if (actor.role === "worker" && arr.winning_site_id !== actor.site_id) {
      throw new ServiceError(403, "not_your_site", "仅生效地点工作人员可换发");
    }
    if (!["worker", "specialist"].includes(actor.role)) throw new ServiceError(403, "forbidden_role", "无权换发");
    const token = randomToken();
    const expires = new Date(clock() + rendezvousTtlMs).toISOString();
    db.prepare("UPDATE arrangements SET rendezvous_token_hash = ?, rendezvous_expires_at = ?, rendezvous_reissued = rendezvous_reissued + 1, updated_at = ? WHERE id = ?")
      .run(sha256(token), expires, at(), arr.id);
    addEvent(arr.id, "rendezvous_reissued", actor.id, {});
    appendAudit(db, { actorId: actor.id, action: "rendezvous_reissued", entityType: "arrangement", entityId: arr.id, detail: {} });
    return { rendezvous_token: token, rendezvous_expires_at: expires };
  }

  // ---------- 人员状态联动 ----------
  function appendRiskNote(arr, kind, note) {
    const notes = arr.risk_note ? JSON.parse(arr.risk_note) : [];
    notes.push({ at: at(), kind, note });
    db.prepare("UPDATE arrangements SET risk_note = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(notes), at(), arr.id);
    addEvent(arr.id, "risk_appended", null, { kind, note });
    appendAudit(db, { actorId: null, action: "risk_appended", entityType: "arrangement", entityId: arr.id, detail: { kind, note } });
  }

  function applyTransfer(actorId, registrationId, toSiteId) {
    const reg = getRegOr404(registrationId);
    if (!getSite(toSiteId)) throw new ServiceError(400, "invalid_site", "目标安置点无效");
    if (reg.subject_site_id === toSiteId) return { unchanged: true };
    db.prepare("UPDATE registrations SET subject_site_id = ?, subject_status = 'transferred', updated_at = ? WHERE id = ?")
      .run(toSiteId, at(), reg.id);
    appendAudit(db, { actorId, action: "person_transferred", entityType: "registration", entityId: reg.id, detail: { from: reg.subject_site_id, to: toSiteId } });
    for (const row of activeArrangementsForReg(reg.id)) {
      const arr = getArrangement(row.id);
      if (arr.state === ArrangementState.CONFIRMED) {
        // 已完成团聚：保留当时授权，追加风险说明
        appendRiskNote(arr, "transfer", `当事人已转移至 ${toSiteId}；原会合授权保留，请核对会合安排是否仍可行`);
      } else {
        addEvent(arr.id, "adjusted_transfer", actorId, { to_site_id: toSiteId });
      }
    }
    return { ok: true, registration_id: reg.id, subject_site_id: toSiteId };
  }

  function applyStatusCorrection(actorId, registrationId, status, note) {
    const reg = getRegOr404(registrationId);
    if (!Object.values(PersonStatus).includes(status)) throw new ServiceError(400, "invalid_status", "未知人员状态");
    if (reg.subject_status === status) return { unchanged: true };
    db.prepare("UPDATE registrations SET subject_status = ?, updated_at = ? WHERE id = ?").run(status, at(), reg.id);
    appendAudit(db, { actorId, action: "status_corrected", entityType: "registration", entityId: reg.id, detail: { from: reg.subject_status, to: status, note: note ?? null } });

    if (!MATCHABLE_STATUSES.includes(status)) {
      // 当事人不再可匹配：未完成安排释放（不删申请），候选失效；已完成仅追加风险说明
      for (const row of activeArrangementsForReg(reg.id)) {
        const arr = getArrangement(row.id);
        if (arr.state === ArrangementState.CONFIRMED) {
          appendRiskNote(arr, "status_correction", `当事人状态更正为 ${status}；团聚授权保留，请注意风险（${note ?? "无备注"}）`);
        } else {
          releaseArrangement(arr, ReleaseReason.STATUS_CORRECTION, actorId, note ?? `当事人状态更正为 ${status}`);
          db.prepare("UPDATE candidates SET status = 'superseded', active_arrangement_id = NULL, updated_at = ? WHERE id = ?")
            .run(at(), arr.candidate_id);
        }
      }
      // 无安排的候选也置为失效
      db.prepare(
        `UPDATE candidates SET status = 'superseded', updated_at = ?
         WHERE status = 'proposed' AND (registration_a = ? OR registration_b = ?)`
      ).run(at(), reg.id, reg.id);
    }
    return { ok: true, registration_id: reg.id, status };
  }

  function applyRestriction(actorId, registrationId, flag, note) {
    const reg = getRegOr404(registrationId);
    if (!RESTRICTIONS.has(flag)) throw new ServiceError(400, "invalid_flag", "未知限制标记");
    if (reg.flags.includes(flag)) return { unchanged: true };
    const flags = [...reg.flags, flag];
    db.prepare("UPDATE registrations SET flags = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(flags), at(), reg.id);
    appendAudit(db, { actorId, action: "restriction_added", entityType: "registration", entityId: reg.id, detail: { flag, note: note ?? null } });
    for (const row of activeArrangementsForReg(reg.id)) {
      const arr = getArrangement(row.id);
      if (arr.state === ArrangementState.CONFIRMED) {
        appendRiskNote(arr, "restriction", `团聚确认后到达限制标记 ${flag}（${note ?? "无备注"}）；原授权保留`);
      } else {
        const reasons = new Set(arr.route_reasons);
        reasons.add(flag);
        db.prepare(
          `UPDATE arrangements SET route = 'specialist_review', state = 'pending_review', route_reasons = ?,
           confirm_deadline = NULL, token_epoch = token_epoch + 1,
           token_a_hash = NULL, token_b_hash = NULL, confirmed_a_at = NULL, confirmed_b_at = NULL,
           updated_at = ? WHERE id = ?`
        ).run(JSON.stringify([...reasons]), at(), arr.id);
        addEvent(arr.id, "rerouted_to_review", actorId, { flag, note: note ?? null });
        appendAudit(db, { actorId, action: "arrangement_rerouted", entityType: "arrangement", entityId: arr.id, detail: { flag } });
      }
    }
    return { ok: true, registration_id: reg.id, flags };
  }

  // ---------- 超时扫描 / 停机恢复 ----------
  function sweepExpired(actorId = null) {
    let released = 0;
    const rows = db.prepare("SELECT * FROM arrangements WHERE state = 'awaiting_confirmations' AND confirm_deadline < ?").all(at());
    for (const row of rows) {
      releaseArrangement(getArrangement(row.id), ReleaseReason.TIMEOUT, actorId, "确认凭据超时未完成");
      released += 1;
    }
    return { released, swept_at: at() };
  }

  /** 系统恢复后：凭据有效期按原截止时间继续，不重设；复核队列原样保留 */
  function reconcile() {
    const sweep = sweepExpired();
    const pendingTokens = db.prepare(
      "SELECT id, confirm_deadline FROM arrangements WHERE state = 'awaiting_confirmations'"
    ).all().map((x) => ({ arrangement_id: x.id, expires_at: x.confirm_deadline, ms_remaining: Math.max(0, Date.parse(x.confirm_deadline) - clock()) }));
    const rvTokens = db.prepare(
      "SELECT id, rendezvous_expires_at FROM arrangements WHERE state = 'confirmed' AND rendezvous_expires_at IS NOT NULL"
    ).all().map((x) => ({ arrangement_id: x.id, expires_at: x.rendezvous_expires_at, ms_remaining: Math.max(0, Date.parse(x.rendezvous_expires_at) - clock()) }));
    return {
      reconciled_at: at(),
      released_timeout: sweep.released,
      confirmation_tokens: pendingTokens,
      rendezvous_tokens: rvTokens,
      review_queue: reviewQueue().length,
    };
  }

  // ---------- 指挥席汇总（无 PII） ----------
  function commandSummary() {
    sweepExpired();
    const count = (sql, ...params) => db.prepare(sql).get(...params).c;
    const statusBreakdown = Object.fromEntries(
      db.prepare("SELECT subject_status, COUNT(*) c FROM registrations GROUP BY subject_status").all().map((r) => [r.subject_status, r.c])
    );
    const candidateBreakdown = Object.fromEntries(
      db.prepare("SELECT confidence, status, COUNT(*) c FROM candidates GROUP BY confidence, status").all()
        .map((r) => [`${r.confidence}:${r.status}`, r.c])
    );
    const arrangements = db.prepare("SELECT * FROM arrangements").all();
    const byState = {};
    const blockers = [];
    for (const a of arrangements) {
      byState[a.state] = (byState[a.state] ?? 0) + 1;
      if (a.state === "pending_review") {
        blockers.push({ arrangement_id: a.id, kind: "awaiting_specialist_review", reasons: JSON.parse(a.route_reasons), since: a.created_at });
      } else if (a.state === "awaiting_confirmations" && Date.parse(a.confirm_deadline) < clock()) {
        blockers.push({ arrangement_id: a.id, kind: "confirmation_deadline_passed", deadline: a.confirm_deadline });
      }
    }
    const recentReleases = db.prepare(
      "SELECT id, state, release_reason, released_at FROM arrangements WHERE state IN ('released','rejected') ORDER BY released_at DESC LIMIT 20"
    ).all();
    const sites = db.prepare(
      `SELECT s.id, s.name,
        (SELECT COUNT(*) FROM registrations r WHERE r.registering_site_id = s.id) registrations,
        (SELECT COUNT(*) FROM registrations r WHERE r.subject_site_id = s.id) present_subjects
       FROM sites s`
    ).all();
    return {
      generated_at: at(),
      registrations: { total: count("SELECT COUNT(*) c FROM registrations"), by_status: statusBreakdown },
      candidates: { total: count("SELECT COUNT(*) c FROM candidates"), breakdown: candidateBreakdown },
      arrangements: { total: arrangements.length, by_state: byState },
      blockers,
      recent_releases: recentReleases,
      sites,
    };
  }

  // ---------- 审计员重建 ----------
  function auditAccess(actor, kind, id) {
    if (kind === "candidate") {
      const c = getCandidate(id);
      const pair = candidatePair(c);
      appendAudit(db, { actorId: actor.id, action: "sensitive_access", entityType: "candidate", entityId: id,
        detail: { reason: "audit_reconstruction", scope: "matching_clues" } });
      return { candidate: c, sides: { a: pair.regA, b: pair.regB } };
    }
    if (kind === "arrangement") {
      const x = getArrangement(id);
      const events = db.prepare("SELECT * FROM arrangement_events WHERE arrangement_id = ? ORDER BY at ASC").all(id)
        .map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
      appendAudit(db, { actorId: actor.id, action: "sensitive_access", entityType: "arrangement", entityId: id,
        detail: { reason: "audit_reconstruction", scope: "confirmation_process" } });
      const c = getCandidate(x.candidate_id);
      return { arrangement: scrubTokens(x), events, candidate: { id: c.id, score: c.score, confidence: c.confidence, basis: c.basis } };
    }
    throw new ServiceError(404, "unknown_kind", "未知审计对象");
  }

  function scrubTokens(x) {
    const { token_a_hash, token_b_hash, rendezvous_token_hash, ...rest } = x;
    return { ...rest, token_a_present: Boolean(token_a_hash), token_b_present: Boolean(token_b_hash), rendezvous_token_present: Boolean(rendezvous_token_hash) };
  }

  function auditAccesses() {
    return db.prepare("SELECT id, at, actor_id, action, entity_type, entity_id, detail FROM audit_log WHERE action = 'sensitive_access' ORDER BY id ASC").all()
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  function arrangementView(actor, id) {
    const arr = getArrangement(id);
    if (actor.role === "worker") {
      const regs = [getReg(arr.side_a_registration_id), getReg(arr.side_b_registration_id)];
      const involved = regs.some((r) => r.registering_site_id === actor.site_id || r.subject_site_id === actor.site_id);
      if (!involved && arr.winning_site_id !== actor.site_id) throw new ServiceError(403, "not_your_site", "只能查看本点相关安排");
    } else if (!["specialist", "commander", "auditor"].includes(actor.role)) {
      throw new ServiceError(403, "forbidden_role", "无权查看");
    }
    return scrubTokens(arr);
  }

  return {
    ingestDeviceEvent, listCandidatesForWorker, viewCandidate, startArrangement,
    issueConfirmationToken, confirmByToken, declineArrangement,
    reviewQueue, reviewDetail, specialistDecision,
    rendezvousByToken, reissueRendezvous,
    applyTransfer, applyStatusCorrection, applyRestriction,
    sweepExpired, reconcile, commandSummary,
    auditAccess, auditAccesses, arrangementView, getActor,
    // 测试/直接录入辅助
    registerDirect(actor, input) {
      const data = validateRegistration({ ...input, registering_site_id: input?.registering_site_id ?? actor.site_id });
      if (actor.role === "worker" && actor.site_id && data.registering_site_id !== actor.site_id) {
        throw new ServiceError(403, "site_mismatch", "只能登记本安置点人员");
      }
      const reg = insertRegistration(data, actor.id);
      generateCandidates(reg, actor.id);
      return reg;
    },
  };
}
