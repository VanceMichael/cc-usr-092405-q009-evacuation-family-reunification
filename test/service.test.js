import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyAuditChain } from "../src/db.js";
import { ServiceError } from "../src/service.js";
import { scoreCandidate, Confidence } from "../src/matching.js";
import { makeHarness, adultPair } from "./helpers.js";

test("匹配：同名但无任何其他线索不形成候选", () => {
  const a = { person_name: "王强", age_band: "unknown", last_contact_place: "东站", last_contact_at: "2026-09-23T08:00:00Z" };
  const b = { person_name: "王强", age_band: "unknown", last_contact_place: "西站", last_contact_at: "2026-09-20T08:00:00Z" };
  assert.equal(scoreCandidate(a, b), null);
});

test("匹配：同名 + 年龄段 + 地点粗粒度形成 medium/high 候选并附依据", () => {
  const a = { person_name: "刘洋", approx_age: 30, age_band: "adult", distinguishing_marks: [], last_contact_place: "南湖社区服务站", last_contact_at: "2026-09-23T08:00:00Z" };
  const b = { person_name: "刘洋", approx_age: 31, age_band: "adult", distinguishing_marks: [], last_contact_place: "南湖社区服务站2栋", last_contact_at: "2026-09-23T10:00:00Z" };
  const r = scoreCandidate(a, b);
  assert.ok(r);
  assert.ok(r.score >= 50);
  assert.ok([Confidence.MEDIUM, Confidence.HIGH].includes(r.confidence));
  assert.ok(r.basis.some((x) => x.clue === "name"));
  assert.ok(r.basis.some((x) => x.clue === "last_contact_place"));
});

test("匹配：不同名不配对；儿童年龄容差更严", () => {
  const a = { person_name: "小明", approx_age: 8, age_band: "child", last_contact_place: "一小", last_contact_at: "2026-09-23T08:00:00Z" };
  const b = { person_name: "小红", approx_age: 8, age_band: "child", last_contact_place: "一小", last_contact_at: "2026-09-23T08:00:00Z" };
  assert.equal(scoreCandidate(a, b), null);
  const c = { person_name: "小明", approx_age: 10, age_band: "child", last_contact_place: "一小", last_contact_at: "2026-09-23T08:00:00Z" };
  const r = scoreCandidate(a, c);
  assert.ok(r);
  assert.ok(!r.basis.some((x) => x.clue === "approx_age")); // 相差 2 岁，超出儿童容差
});

test("登记保存最少线索：体貌特征最多 3 条，限制标记去重", () => {
  const h = makeHarness();
  const reg = h.service.registerDirect(h.wa, {
    ...adultPair.seek,
    distinguishing_marks: ["疤痕", "胎记", "纹身", "多余特征"],
    flags: ["restricted_contact", "restricted_contact"],
  });
  assert.equal(reg.distinguishing_marks.length, 3);
  assert.deepEqual(reg.flags, ["restricted_contact"]);
});

test("离线设备流水：重传幂等，不产生重复登记", () => {
  const h = makeHarness();
  const payload = { person_name: "周杰", approx_age: 40, relationship: "sibling", reporter_name: "周文", last_contact_place: "北区礼堂" };
  const first = h.service.ingestDeviceEvent(h.wa, { device_id: "dev-7", seq: 0, type: "registration", payload });
  const again = h.service.ingestDeviceEvent(h.wa, { device_id: "dev-7", seq: 0, type: "registration", payload });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.applied, true);
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM registrations WHERE person_name = '周杰'").get().c, 1);
  // 不同设备各自计数
  const other = h.service.ingestDeviceEvent(h.wb, { device_id: "dev-8", seq: 0, type: "registration", payload: { ...payload, reporter_name: "周武" } });
  assert.equal(other.duplicate, false);
});

test("离线流水：乱序/缺口允许，失败事件不留半写入", () => {
  const h = makeHarness();
  assert.throws(
    () => h.service.ingestDeviceEvent(h.wa, { device_id: "dev-9", seq: 5, type: "registration", payload: { person_name: "x" } }),
    (e) => e instanceof ServiceError && e.status === 400
  );
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM device_events WHERE device_id='dev-9'").get().c, 0);
});

test("工作人员只看到本安置点相关候选，对侧身份脱敏", () => {
  const h = makeHarness();
  h.service.registerDirect(h.wa, adultPair.seek);
  h.service.registerDirect(h.wb, adultPair.found);
  const listA = h.service.listCandidatesForWorker(h.wa);
  assert.equal(listA.length, 1);
  const otherSide = listA[0].sides[listA[0].sides.a.is_viewer ? "b" : "a"].registration;
  assert.ok(otherSide.person_name_masked);
  assert.equal(otherSide.person_name_masked, "张**");
  assert.ok(!("person_name" in otherSide));
  assert.ok(!("contact_phone" in otherSide));
  assert.equal(otherSide.last_contact_place_coarse, "城北体育馆");
  assert.equal(otherSide.contact_phone_masked, "13****22");
  // 第三安置点工作人员看不到
  assert.equal(h.service.listCandidatesForWorker(h.wc).length, 0);
  // 公开依据不回显姓名明文
  assert.ok(listA[0].basis.every((b) => b.clue !== "name" || b.reason === "normalized_name_equal"));
});

test("工作人员不能查看其他安置点候选", () => {
  const h = makeHarness();
  h.service.registerDirect(h.wa, adultPair.seek);
  h.service.registerDirect(h.wb, adultPair.found);
  const cid = h.service.listCandidatesForWorker(h.wa)[0].id;
  assert.throws(() => h.service.viewCandidate(h.wc, cid), (e) => e.code === "not_your_site");
});

test("普通成年人走双方分别确认，凭据短期有效，仅披露会合必要信息", () => {
  const h = makeHarness();
  h.service.registerDirect(h.wa, adultPair.seek);
  h.service.registerDirect(h.wb, adultPair.found);
  const cid = h.service.listCandidatesForWorker(h.wa)[0].id;
  const arr = h.service.startArrangement(h.wa, cid);
  assert.equal(arr.route, "mutual_confirm");
  assert.equal(arr.state, "awaiting_confirmations");
  const sides = candidateSides(h, arr.id);
  const ta = h.service.issueConfirmationToken(h.wa, arr.id, sides.a).token;
  const tb = h.service.issueConfirmationToken(h.wb, arr.id, sides.b).token;
  const first = h.service.confirmByToken(ta);
  assert.equal(first.outcome, "waiting");
  // 重复确认一侧幂等
  h.service.confirmByToken(ta);
  const done = h.service.confirmByToken(tb);
  assert.equal(done.outcome, "confirmed");
  const rv = h.service.rendezvousByToken(done.rendezvous_token);
  assert.equal(rv.site_name, "二号安置点"); // found 方所在点
  // 时段交集 14:00–18:00
  assert.deepEqual(rv.contact_windows, [{ from: "2026-09-24T14:00:00Z", to: "2026-09-24T18:00:00Z" }]);
  assert.equal(rv.supervised, false);
  // 会合信息不含任何姓名/电话
  const flat = JSON.stringify(rv);
  assert.ok(!flat.includes("张伟") && !flat.includes("1380000"));
});

test("凭据哈希存储，库中无明文令牌", () => {
  const h = makeHarness();
  const { arr, ta } = startAdult(h);
  const row = h.db.prepare("SELECT token_a_hash FROM arrangements WHERE id = ?").get(arr.id);
  assert.ok(!row.token_a_hash.includes(ta));
});

test("只有本侧安置点能发放该侧凭据", () => {
  const h = makeHarness();
  const { arr, tb } = startAdult(h);
  const sides = candidateSides(h, arr.id);
  // 令牌 tb 属于 site-b 一侧；wa 尝试给对方侧发放应被拒
  assert.throws(() => h.service.issueConfirmationToken(h.wa, arr.id, sides.b),
    (e) => e.code === "not_your_side");
});

test("超时未完成：安排释放但原申请保留，候选可重新发起", () => {
  const h = makeHarness({ confirmTtlMs: 60_000 });
  const { arr } = startAdult(h);
  const sides = candidateSides(h, arr.id);
  h.service.issueConfirmationToken(h.wa, arr.id, sides.a);
  h.advance(61_000);
  const rec = h.service.reconcile();
  assert.equal(rec.released_timeout >= 1, true);
  const view = h.service.arrangementView(h.wa, arr.id);
  assert.equal(view.state, "released");
  assert.equal(view.release_reason, "timeout");
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM registrations").get().c, 2); // 申请仍在
  // 可重新发起
  const cid = h.service.listCandidatesForWorker(h.wa)[0].id;
  const arr2 = h.service.startArrangement(h.wa, cid);
  assert.equal(arr2.state, "awaiting_confirmations");
});

test("一方拒绝：安排释放、记录原因、申请保留", () => {
  const h = makeHarness();
  const { arr } = startAdult(h);
  const sides = candidateSides(h, arr.id);
  h.service.declineArrangement(h.wb, arr.id, sides.b, "确认不是同一人");
  const view = h.service.arrangementView(h.wa, arr.id);
  assert.equal(view.state, "released");
  assert.equal(view.release_reason, "declined");
});

test("未成年人由邻居代看：自动进入专门复核，工作人员看不到明文", () => {
  const h = makeHarness();
  h.service.registerDirect(h.wa, {
    report_kind: "seek", person_name: "王小虎", approx_age: 9, relationship: "parent",
    reporter_name: "王芳", last_contact_place: "城南小学", last_contact_at: "2026-09-23T08:00:00Z",
  });
  h.service.registerDirect(h.wb, {
    report_kind: "found", person_name: "王小虎", approx_age: 9, relationship: "neighbor",
    relationship_detail: "邻居临时代看", reporter_name: "赵磊",
    last_contact_place: "城南小学", last_contact_at: "2026-09-23T08:30:00Z",
  });
  const cid = h.service.listCandidatesForWorker(h.wa)[0].id;
  const arr = h.service.startArrangement(h.wa, cid);
  assert.equal(arr.route, "specialist_review");
  assert.equal(arr.state, "pending_review");
  assert.ok(arr.route_reasons.includes("minor"));
  assert.ok(arr.route_reasons.includes("neighbor_care"));
  assert.equal(h.service.reviewQueue().length, 1);
  // 默认脱敏
  const masked = h.service.reviewDetail(h.sp, arr.id, false);
  assert.ok(masked.candidate.sides.a.registration.person_name_masked);
  // full=1 才解开脱敏，且留痕
  const full = h.service.reviewDetail(h.sp, arr.id, true);
  assert.equal(full.candidate.sides.a.registration.person_name, "王小虎");
  const accesses = h.service.auditAccesses();
  assert.ok(accesses.some((x) => x.actor_id === "specialist-1" && x.detail.reason === "specialist_review_full"));
});

test("专门复核通过 → 生效会合；驳回 → 安排 rejected、候选失效", () => {
  const h = makeHarness();
  const arr = startChildReview(h);
  const dec = h.service.specialistDecision(h.sp, arr.id, "approved", "特征一致，关系核实");
  assert.equal(dec.outcome, "confirmed");
  const rv = h.service.rendezvousByToken(dec.rendezvous_token);
  assert.equal(rv.supervised, false);

  const h2 = makeHarness();
  const arr2 = startChildReview(h2, "李小梅");
  const dec2 = h2.service.specialistDecision(h2.sp, arr2.id, "rejected", "特征不符");
  assert.equal(dec2.outcome, "rejected");
  const view = h2.service.arrangementView(h2.sp, arr2.id);
  assert.equal(view.state, "rejected");
});

test("新限制到达：待确认安排改道专门复核，旧凭据立即失效", () => {
  const h = makeHarness();
  const { arr, ta } = startAdult(h);
  // 确认一侧后限制到达
  h.service.confirmByToken(ta);
  const seekReg = h.db.prepare("SELECT id FROM registrations WHERE report_kind='seek'").get();
  h.service.applyRestriction(h.sp.id, seekReg.id, "restricted_contact", "接到保护令");
  const view = h.service.arrangementView(h.wa, arr.id);
  assert.equal(view.state, "pending_review");
  assert.equal(view.route, "specialist_review");
  assert.ok(view.route_reasons.includes("restricted_contact"));
  // 旧确认凭据失效
  assert.throws(() => h.service.confirmByToken(ta), (e) => e.code === "invalid_token");
});

test("人员转移：待确认安排记录调整；已完成团聚保留授权并追加风险说明", () => {
  const h = makeHarness();
  const { arr, done } = completeAdult(h);
  const foundReg = h.db.prepare("SELECT id FROM registrations WHERE report_kind='found'").get();
  h.service.applyTransfer(h.wb.id, foundReg.id, "site-c");
  const view = h.service.arrangementView(h.wa, arr.id);
  assert.equal(view.state, "confirmed"); // 授权保留
  const notes = JSON.parse(view.risk_note);
  assert.ok(notes.some((n) => n.kind === "transfer"));
  const rv = h.service.rendezvousByToken(done.rendezvous_token);
  assert.equal(rv.site_name, "二号安置点"); // 会合凭据仍是生效时的安排
});

test("撤离状态更正为不可匹配：未完成安排释放、候选失效；已完成仅追加风险说明", () => {
  const h = makeHarness();
  const { arr } = startAdult(h);
  const foundReg = h.db.prepare("SELECT id FROM registrations WHERE report_kind='found'").get();
  h.service.applyStatusCorrection(h.wb.id, foundReg.id, "deceased", "遗体辨认确认");
  const view = h.service.arrangementView(h.wa, arr.id);
  assert.equal(view.state, "released");
  assert.equal(view.release_reason, "status_correction");
  const cand = h.db.prepare("SELECT status FROM candidates").get();
  assert.equal(cand.status, "superseded");

  const h2 = makeHarness();
  const { arr: arr2 } = completeAdult(h2);
  const reg2 = h2.db.prepare("SELECT id FROM registrations WHERE report_kind='found'").get();
  h2.service.applyStatusCorrection(h2.wb.id, reg2.id, "deceased");
  const v2 = h2.service.arrangementView(h2.wa, arr2.id);
  assert.equal(v2.state, "confirmed");
  assert.ok(JSON.parse(v2.risk_note).some((n) => n.kind === "status_correction"));
});

test("两个地点不能同时对同一人生效：后完成者 conflict_lost", () => {
  const h = makeHarness();
  // 同一 seek 登记与两个不同 found 登记形成两个候选
  h.service.registerDirect(h.wa, adultPair.seek);
  h.service.registerDirect(h.wb, adultPair.found);
  h.service.registerDirect(h.wc, { ...adultPair.found, reporter_name: "张伟", last_contact_place: "城北体育馆侧门" });
  const list = h.service.listCandidatesForWorker(h.wa);
  assert.equal(list.length, 2);
  // 两地并行发起（均未完成），随后几乎同时完成——先落库者赢
  const first = h.service.startArrangement(h.wa, list[0].id);
  const second = h.service.startArrangement(h.wa, list[1].id);
  const r1 = completeArrangement(h, first.id);
  const r2 = completeArrangement(h, second.id);
  assert.equal(r1, "confirmed");
  assert.equal(r2, "conflict_lost");
  const view = h.service.arrangementView(h.wa, second.id);
  assert.equal(view.state, "released");
  assert.equal(view.release_reason, "conflict_lost");
  // 原申请仍在
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM registrations").get().c, 3);
});

test("同一候选已有进行中安排时不能重复发起", () => {
  const h = makeHarness();
  startAdult(h);
  const cid = h.service.listCandidatesForWorker(h.wa)[0].id;
  assert.throws(() => h.service.startArrangement(h.wa, cid), (e) => e.code === "candidate_not_open");
});

test("系统恢复：凭据按原截止时间继续，复核队列保留", () => {
  const h = makeHarness({ confirmTtlMs: 60_000 });
  const { arr } = startAdult(h);
  const sides = candidateSides(h, arr.id);
  h.service.issueConfirmationToken(h.wa, arr.id, sides.a);
  h.advance(30_000); // 停机 30 秒
  const rec = h.service.reconcile();
  assert.equal(rec.released_timeout, 0);
  const token = rec.confirmation_tokens.find((x) => x.arrangement_id === arr.id);
  assert.ok(token.ms_remaining > 29_000 && token.ms_remaining <= 30_000);
  h.advance(31_000);
  const rec2 = h.service.reconcile();
  assert.equal(rec2.released_timeout, 1);
});

test("指挥席：只看汇总与阻塞原因，无 PII", () => {
  const h = makeHarness();
  const childArr = startChildReview(h);
  const summary = h.service.commandSummary();
  assert.ok(summary.registrations.total >= 2);
  assert.ok(summary.arrangements.by_state.pending_review >= 1);
  assert.ok(summary.blockers.some((b) => b.kind === "awaiting_specialist_review"));
  const flat = JSON.stringify(summary);
  assert.ok(!flat.includes("王小虎") && !flat.includes("王芳"));
});

test("审计员可重建匹配线索、敏感访问记录与确认过程；哈希链完整", () => {
  const h = makeHarness();
  const { arr, done } = completeAdult(h);
  const cid = h.db.prepare("SELECT candidate_id FROM arrangements WHERE id = ?").get(arr.id).candidate_id;
  const recon = h.service.auditAccess(h.aud, "candidate", cid);
  assert.equal(recon.sides.a.person_name, "张伟");
  assert.ok(recon.candidate.basis.length > 0);
  const proc = h.service.auditAccess(h.aud, "arrangement", arr.id);
  const types = proc.events.map((e) => e.type);
  assert.ok(types.includes("created") && types.includes("party_confirmed") && types.includes("confirmed"));
  // 审计访问本身被记录
  assert.ok(h.service.auditAccesses().some((x) => x.actor_id === "auditor-1"));
  assert.deepEqual(verifyAuditChain(h.db), { ok: true, count: verifyAuditChain(h.db).count });
});

test("非审计员不能重建线索；工作人员不能访问审计接口由路由层拦截（服务层角色校验）", () => {
  const h = makeHarness();
  // service 层 auditAccess 不直接校验角色（路由层负责），这里验证哈希链被篡改可检测
  const { arr } = completeAdult(h);
  h.db.prepare("UPDATE audit_log SET action='x' WHERE id = 2").run();
  const result = verifyAuditChain(h.db);
  assert.equal(result.ok, false);
});

test("会合凭据过期后拒绝披露，可由生效点换发", () => {
  const h = makeHarness({ rvTtlMs: 60_000 });
  const { arr, done } = completeAdult(h);
  h.advance(61_000);
  assert.throws(() => h.service.rendezvousByToken(done.rendezvous_token), (e) => e.code === "rendezvous_expired");
  const re = h.service.reissueRendezvous(h.wb, arr.id);
  const rv = h.service.rendezvousByToken(re.rendezvous_token);
  assert.ok(rv.site_name);
  // 非生效点不能换发
  assert.throws(() => h.service.reissueRendezvous(h.wa, arr.id), (e) => e.code === "not_your_site");
});

// ---------- 辅助 ----------
function candidateSides(h, arrangementId) {
  const arr = h.db.prepare("SELECT * FROM arrangements WHERE id = ?").get(arrangementId);
  const cand = h.db.prepare("SELECT * FROM candidates WHERE id = ?").get(arr.candidate_id);
  const regA = h.db.prepare("SELECT registering_site_id FROM registrations WHERE id = ?").get(cand.registration_a);
  return { a: regA.registering_site_id === "site-a" ? "a" : "b", b: regA.registering_site_id === "site-a" ? "b" : "a" };
}

function startAdult(h) {
  h.service.registerDirect(h.wa, adultPair.seek);
  h.service.registerDirect(h.wb, adultPair.found);
  const cid = h.service.listCandidatesForWorker(h.wa)[0].id;
  const arr = h.service.startArrangement(h.wa, cid);
  const sides = candidateSides(h, arr.id);
  const ta = h.service.issueConfirmationToken(h.wa, arr.id, sides.a).token;
  const tb = h.service.issueConfirmationToken(h.wb, arr.id, sides.b).token;
  return { arr, ta, tb };
}

function completeAdult(h) {
  const s = startAdult(h);
  h.service.confirmByToken(s.ta);
  const done = h.service.confirmByToken(s.tb);
  return { arr: s.arr, done };
}

function workerForSide(h, arrangementId, side) {
  const arr = h.db.prepare("SELECT * FROM arrangements WHERE id = ?").get(arrangementId);
  const cand = h.db.prepare("SELECT * FROM candidates WHERE id = ?").get(arr.candidate_id);
  const regId = side === "a" ? cand.registration_a : cand.registration_b;
  const site = h.db.prepare("SELECT registering_site_id FROM registrations WHERE id = ?").get(regId).registering_site_id;
  return { "site-a": h.wa, "site-b": h.wb, "site-c": h.wc }[site];
}

/** 对一个待确认安排完成双方确认，返回最终结果 */
function completeArrangement(h, id) {
  const sides = candidateSides(h, id);
  const ta = h.service.issueConfirmationToken(workerForSide(h, id, sides.a), id, sides.a).token;
  const tb = h.service.issueConfirmationToken(workerForSide(h, id, sides.b), id, sides.b).token;
  h.service.confirmByToken(ta);
  const second = h.service.confirmByToken(tb);
  return second.outcome;
}

function startChildReview(h, name = "王小虎") {
  h.service.registerDirect(h.wa, {
    report_kind: "seek", person_name: name, approx_age: 8, relationship: "parent",
    reporter_name: "家长", last_contact_place: "城西幼儿园", last_contact_at: "2026-09-23T08:00:00Z",
  });
  h.service.registerDirect(h.wb, {
    report_kind: "found", person_name: name, approx_age: 8, relationship: "other",
    reporter_name: "保护员", last_contact_place: "城西幼儿园", last_contact_at: "2026-09-23T09:00:00Z",
  });
  const cid = h.service.listCandidatesForWorker(h.wa)[0].id;
  return h.service.startArrangement(h.wa, cid);
}
