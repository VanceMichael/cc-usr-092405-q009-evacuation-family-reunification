import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { harness, registerPair, openPair, confirmSide } from "./helpers.js";

test("普通成年人：双方分别确认后签发短期凭据，只含会合必要信息", async () => {
  const h = harness();
  const { candidateId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.body.status, "pending");
  assert.equal(opened.body.sensitive_reason, null);

  const c1 = await confirmSide(h.app, opened.body.arrangement_id, "seeking");
  assert.deepEqual(c1.body.confirmed_sides, ["seeking"]);
  // 仅一方确认时尚无凭据
  const noCred = await request(h.app)
    .get(`/arrangements/${opened.body.arrangement_id}/credential`)
    .set("x-staff-id", "w1");
  assert.equal(noCred.status, 409);

  await confirmSide(h.app, opened.body.arrangement_id, "located");
  const cred = await request(h.app)
    .get(`/arrangements/${opened.body.arrangement_id}/credential`)
    .set("x-staff-id", "w1");
  assert.equal(cred.status, 200);
  assert.match(cred.body.code, /^M-/);
  // 凭据短期有效：签发时间 + 凭据 TTL（测试时钟未推进）
  assert.equal(Date.parse(cred.body.expires_at), 1_700_000_000_000 + 120_000);
  assert.equal(cred.body.meeting.supervised, false);
  assert.ok(cred.body.meeting.meeting_site);
  assert.ok(cred.body.meeting.windows.seeking);
  // 会合信息不含身份线索原值或关系之外的敏感字段
  const raw = JSON.stringify(cred.body.meeting);
  assert.ok(!raw.includes("纹身"));
  h.close();
});

test("确认必须由该方所在安置点工作人员作出", async () => {
  const h = harness();
  const { candidateId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  // 双方都登记在 S1，S2 工作人员不能代为确认
  const forbidden = await confirmSide(h.app, opened.body.arrangement_id, "seeking", "w2");
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error, "not_your_side");
  h.close();
});

test("任一方拒绝：释放占用、候选重新开放，但原申请保留", async () => {
  const h = harness();
  const { candidateId, seekingId, locatedId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  const reject = await request(h.app)
    .post(`/arrangements/${opened.body.arrangement_id}/reject`)
    .set("x-staff-id", "w1")
    .send({ side: "located", reason: "家属辨认不符" });
  assert.equal(reject.body.status, "rejected");

  const claims = h.db
    .prepare("SELECT COUNT(*) AS n FROM active_claims WHERE arrangement_id = ?")
    .get(opened.body.arrangement_id).n;
  assert.equal(claims, 0);
  const candidate = h.db.prepare("SELECT status FROM match_candidates WHERE candidate_id = ?").get(candidateId);
  assert.equal(candidate.status, "open");
  // 原申请未被抹去
  assert.ok(h.db.prepare("SELECT * FROM reports WHERE report_id = ?").get(seekingId));
  assert.ok(h.db.prepare("SELECT * FROM reports WHERE report_id = ?").get(locatedId));
  // 安排行也以终结状态留存
  const arr = h.db.prepare("SELECT * FROM arrangements WHERE arrangement_id = ?").get(opened.body.arrangement_id);
  assert.equal(arr.status, "rejected");
  h.close();
});

test("确认超时：安排转为 expired 并释放占用，候选重新开放", async () => {
  const h = harness({ ttl: { confirm: 60_000, credential: 120_000 } });
  const { candidateId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  await confirmSide(h.app, opened.body.arrangement_id, "seeking");
  h.advance(61_000);
  h.app.services.sweepTimeouts();

  const arr = h.db.prepare("SELECT * FROM arrangements WHERE arrangement_id = ?").get(opened.body.arrangement_id);
  assert.equal(arr.status, "expired");
  assert.equal(arr.release_reason, "timeout");
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM active_claims").get().n, 0);
  assert.equal(h.db.prepare("SELECT status FROM match_candidates WHERE candidate_id = ?").get(candidateId).status, "open");

  // 超时后重新发起可成功（占用已释放）
  const reopened = await openPair(h.app, candidateId);
  assert.equal(reopened.status, 201, reopened.text);
  h.close();
});

test("同一人的两处候选同时发起：只有一处生效", async () => {
  const h = harness();
  const { candidateId, locatedId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  assert.equal(opened.status, 201);

  // 同一在场登记与另一条寻人记录构成第二处候选
  const { default: request } = await import("supertest");
  const secondSeeking = await request(h.app)
    .post("/reports")
    .set("x-staff-id", "w1")
    .send({
      side: "seeking",
      person_name: "李华",
      est_age: 34,
      gender: "女",
      last_contact_place: "三号桥东侧避难楼梯",
      clues: [{ type: "tattoo", value: "手腕玫瑰纹身" }],
    });
  const candidates = await request(h.app).get("/candidates").set("x-staff-id", "w1");
  const other = candidates.body.candidates.find(
    (c) => c.seeking.report_id === secondSeeking.body.report_id && c.located.report_id === locatedId
  );
  assert.ok(other, "应当出现第二个候选");
  const clash = await openPair(h.app, other.candidate_id);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, "arrangement_active_elsewhere");
  h.close();
});

test("凭据在会合时限过后失效，过期凭据不能完成团聚", async () => {
  const h = harness({ ttl: { confirm: 60_000, credential: 120_000 } });
  const { candidateId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  await confirmSide(h.app, opened.body.arrangement_id, "seeking");
  await confirmSide(h.app, opened.body.arrangement_id, "located");
  h.advance(121_000);
  const complete = await request(h.app)
    .post(`/arrangements/${opened.body.arrangement_id}/complete`)
    .set("x-staff-id", "w1")
    .send({});
  assert.equal(complete.status, 409);
  const arr = h.db.prepare("SELECT status FROM arrangements WHERE arrangement_id = ?").get(opened.body.arrangement_id);
  assert.equal(arr.status, "expired");
  h.close();
});

test("正常完成团聚后状态为 completed，凭据作废", async () => {
  const h = harness();
  const { candidateId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  await confirmSide(h.app, opened.body.arrangement_id, "seeking");
  await confirmSide(h.app, opened.body.arrangement_id, "located");
  const done = await request(h.app)
    .post(`/arrangements/${opened.body.arrangement_id}/complete`)
    .set("x-staff-id", "w1")
    .send({});
  assert.equal(done.body.status, "completed");
  const validCreds = h.db
    .prepare("SELECT COUNT(*) AS n FROM credentials WHERE arrangement_id = ? AND status = 'valid'")
    .get(opened.body.arrangement_id).n;
  assert.equal(validCreds, 0);
  h.close();
});
