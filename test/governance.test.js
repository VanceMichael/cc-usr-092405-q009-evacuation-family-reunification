import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { harness, registerPair, openPair, confirmSide } from "./helpers.js";

test("指挥席看到汇总数字与阻塞原因，但看不到姓名等敏感明细", async () => {
  const h = harness();
  const adult = await registerPair(h.app);
  const opened = await openPair(h.app, adult.candidateId);
  await confirmSide(h.app, opened.body.arrangement_id, "seeking"); // 缺 located 确认

  const minor = await registerPair(h.app, {
    seeking: { person_name: "童童", est_age: 6, last_contact_place: "幼儿园", clues: [{ type: "bag", value: "黄书包" }] },
    located: { person_name: "童童", est_age: 6, last_contact_place: "幼儿园", clues: [{ type: "bag", value: "黄书包" }] },
  });
  await openPair(h.app, minor.candidateId);

  const res = await request(h.app).get("/command/summary").set("x-staff-id", "cmd1");
  assert.equal(res.status, 200);
  assert.equal(res.body.arrangements.pending, 1);
  assert.equal(res.body.arrangements.in_review, 1);
  assert.equal(res.body.blockers.awaiting_side_confirmation, 1);
  assert.equal(res.body.blockers.awaiting_specialist_review, 1);

  const blockedPending = res.body.blocked.find((b) => b.reason === "awaiting_side_confirmation");
  assert.equal(blockedPending.missing_confirmations, 1);
  assert.ok(blockedPending.deadline);
  // 汇总中不出现任何姓名/线索
  assert.ok(!JSON.stringify(res.body).includes("童童"));
  assert.ok(!JSON.stringify(res.body).includes("黄书包"));
  h.close();
});

test("普通工作人员与专员不能访问指挥席汇总", async () => {
  const h = harness();
  for (const id of ["w1", "sp1", "aud1"]) {
    const res = await request(h.app).get("/command/summary").set("x-staff-id", id);
    assert.equal(res.status, 403, id);
  }
  h.close();
});

test("仅授权审计员可重建匹配线索、访问者与确认过程", async () => {
  const h = harness();
  const pair = await registerPair(h.app);
  const opened = await openPair(h.app, pair.candidateId);
  await confirmSide(h.app, opened.body.arrangement_id, "seeking");
  // 专员查看过全值详情
  await request(h.app).get(`/arrangements/${opened.body.arrangement_id}`).set("x-staff-id", "sp1");

  // 非审计员被拒绝
  const denied = await request(h.app)
    .get(`/audit/reconstruction?arrangement_id=${opened.body.arrangement_id}`)
    .set("x-staff-id", "w1");
  assert.equal(denied.status, 403);

  const res = await request(h.app)
    .get(`/audit/reconstruction?arrangement_id=${opened.body.arrangement_id}`)
    .set("x-staff-id", "aud1");
  assert.equal(res.status, 200, res.text);

  // 重建匹配所使用的线索原值
  const clueValues = res.body.reports.flatMap((r) => r.clues.map((c) => c.value));
  assert.ok(clueValues.includes("手腕玫瑰纹身"));
  // 候选的置信依据
  assert.equal(res.body.candidates[0].factors.some((f) => f.factor === "shared_clue"), true);
  // 确认过程时间线
  const actions = res.body.timeline.map((e) => e.action);
  assert.ok(actions.includes("arrangement_opened"));
  assert.ok(actions.includes("side_confirmed"));
  // 敏感信息访问者：包含专员查看全值与本次审计重建
  const accessActors = res.body.sensitive_access.map((e) => e.actor_id);
  assert.ok(accessActors.includes("sp1"));
  assert.ok(accessActors.includes("aud1"));
  h.close();
});

test("审计员可按登记重建：看到其全部候选与关联安排", async () => {
  const h = harness();
  const pair = await registerPair(h.app);
  const opened = await openPair(h.app, pair.candidateId);
  await confirmSide(h.app, opened.body.arrangement_id, "seeking");
  await confirmSide(h.app, opened.body.arrangement_id, "located");

  const res = await request(h.app)
    .get(`/audit/reconstruction?report_id=${pair.seekingId}`)
    .set("x-staff-id", "aud1");
  assert.equal(res.status, 200);
  assert.equal(res.body.candidates.length, 1);
  assert.equal(res.body.arrangements.length, 1);
  assert.equal(res.body.arrangements[0].arrangement_id, opened.body.arrangement_id);
  h.close();
});

test("审计访问本身也被记录（审计员行为可追溯）", async () => {
  const h = harness();
  const pair = await registerPair(h.app);
  await request(h.app)
    .get(`/audit/reconstruction?report_id=${pair.seekingId}`)
    .set("x-staff-id", "aud1");
  const rows = h.db
    .prepare("SELECT actor_id, action FROM audit_events WHERE actor_id = 'aud1'")
    .all();
  assert.equal(rows.some((r) => r.action === "audit_reconstruction"), true);
  h.close();
});
