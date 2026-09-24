import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { harness, registerPair, openPair, confirmSide, postReport } from "./helpers.js";

test("未成年人自动转专门人员复核，普通工作人员看不到复核队列", async () => {
  const h = harness();
  const { candidateId } = await registerPair(h.app, {
    seeking: { est_age: 8 },
    located: { est_age: 8, minor_flag: true },
  });
  const opened = await openPair(h.app, candidateId);
  assert.equal(opened.body.status, "in_review");
  assert.equal(opened.body.sensitive_reason, "minor");

  const workerDenied = await request(h.app).get("/reviews").set("x-staff-id", "w1");
  assert.equal(workerDenied.status, 403);

  const queue = await request(h.app).get("/reviews").set("x-staff-id", "sp1");
  assert.equal(queue.body.arrangements.length, 1);
  // 复核视图可见原值以便专员判断（访问写审计，另在审计测试验证）
  assert.ok(queue.body.arrangements[0].seeking.person_name);
  h.close();
});

test("专员复核通过：敏感情形在监督接待区会合", async () => {
  const h = harness();
  const { candidateId } = await registerPair(h.app, {
    seeking: { est_age: 9 },
    located: { est_age: 9 },
  });
  const opened = await openPair(h.app, candidateId);
  const review = await request(h.app)
    .post(`/arrangements/${opened.body.arrangement_id}/review`)
    .set("x-staff-id", "sp1")
    .send({ decision: "approve", note: "核对邻居临时代看说明与户籍照片" });
  assert.equal(review.status, 200, review.text);
  assert.equal(review.body.status, "approved");

  const cred = await request(h.app)
    .get(`/arrangements/${opened.body.arrangement_id}/credential`)
    .set("x-staff-id", "sp1");
  assert.equal(cred.body.meeting.supervised, true);
  assert.match(cred.body.meeting.meeting_point, /监督|工作人员在场/);

  const done = await request(h.app)
    .post(`/arrangements/${opened.body.arrangement_id}/complete`)
    .set("x-staff-id", "w1")
    .send({});
  assert.equal(done.body.status, "completed");
  h.close();
});

test("专员复核驳回：释放占用、候选重新开放", async () => {
  const h = harness();
  const { candidateId } = await registerPair(h.app, {
    seeking: { est_age: 7 },
    located: { est_age: 7 },
  });
  const opened = await openPair(h.app, candidateId);
  const review = await request(h.app)
    .post(`/arrangements/${opened.body.arrangement_id}/review`)
    .set("x-staff-id", "sp1")
    .send({ decision: "reject", note: "监护证明不足" });
  assert.equal(review.body.status, "rejected");
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM active_claims").get().n, 0);
  assert.equal(h.db.prepare("SELECT status FROM match_candidates WHERE candidate_id = ?").get(candidateId).status, "open");
  h.close();
});

test("邻居临时代看：无监护关系声明的未成年人安排必须经专员，不能双方直认", async () => {
  const h = harness();
  // 在场方为邻居登记，关系声明明确非监护人
  const { candidateId } = await registerPair(h.app, {
    seeking: { est_age: 6, relationship_decl: "母亲" },
    located: { est_age: 6, relationship_decl: "邻居临时代看" },
  });
  const opened = await openPair(h.app, candidateId);
  assert.equal(opened.body.status, "in_review");
  // 工作人员尝试按普通双方确认 → 状态不允许
  const confirm = await confirmSide(h.app, opened.body.arrangement_id, "seeking");
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.error, "not_pending");
  h.close();
});

test("新限制接触到达：已发凭据作废、未完成安排转复核；已完成团聚保留并追加风险说明", async () => {
  const h = harness();
  // 第一对：完成团聚
  const first = await registerPair(h.app);
  const firstOpened = await openPair(h.app, first.candidateId);
  await confirmSide(h.app, firstOpened.body.arrangement_id, "seeking");
  await confirmSide(h.app, firstOpened.body.arrangement_id, "located");
  await request(h.app)
    .post(`/arrangements/${firstOpened.body.arrangement_id}/complete`)
    .set("x-staff-id", "w1")
    .send({});

  // 第二对：刚双方确认、凭据有效
  const second = await registerPair(h.app, {
    seeking: { person_name: "冯远", est_age: 38, last_contact_place: "体育馆", clues: [{ type: "ring", value: "银戒指" }] },
    located: { person_name: "冯远", est_age: 38, last_contact_place: "体育馆", clues: [{ type: "ring", value: "银戒指" }] },
  });
  const secondOpened = await openPair(h.app, second.candidateId);
  await confirmSide(h.app, secondOpened.body.arrangement_id, "seeking");
  await confirmSide(h.app, secondOpened.body.arrangement_id, "located");
  const credBefore = await request(h.app)
    .get(`/arrangements/${secondOpened.body.arrangement_id}/credential`)
    .set("x-staff-id", "w1");
  assert.equal(credBefore.status, 200);

  // 针对第二对的限制令到达
  const add = await request(h.app)
    .post("/restrictions")
    .set("x-staff-id", "sp1")
    .send({
      type: "contact_restriction",
      subject_report_id: second.locatedId,
      counterparty_report_id: second.seekingId,
      detail: "法院限制接触令到达",
    });
  assert.equal(add.status, 201, add.text);

  const pending = h.db.prepare("SELECT * FROM arrangements WHERE arrangement_id = ?").get(secondOpened.body.arrangement_id);
  assert.equal(pending.status, "in_review");
  assert.equal(pending.sensitive_reason, "contact_restriction");
  const validCreds = h.db
    .prepare("SELECT COUNT(*) AS n FROM credentials WHERE arrangement_id = ? AND status = 'valid'")
    .get(secondOpened.body.arrangement_id).n;
  assert.equal(validCreds, 0);

  // 针对已完成第一对的限制令到达：不撤销团聚，只追加风险说明，授权快照保留
  await request(h.app)
    .post("/restrictions")
    .set("x-staff-id", "sp1")
    .send({
      type: "contact_restriction",
      subject_report_id: first.locatedId,
      counterparty_report_id: first.seekingId,
      detail: "事后补充的限制记录",
    });
  const completed = h.db.prepare("SELECT * FROM arrangements WHERE arrangement_id = ?").get(firstOpened.body.arrangement_id);
  assert.equal(completed.status, "completed");
  assert.ok(completed.authorization_snapshot_json);
  const notes = h.db
    .prepare("SELECT kind, note FROM risk_notes WHERE arrangement_id = ?")
    .all(firstOpened.body.arrangement_id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "new_restriction");
  assert.match(notes[0].note, /contact_restriction/);
  h.close();
});

test("监护争议标记：已发起安排转专员复核", async () => {
  const h = harness();
  const { candidateId, seekingId, locatedId } = await registerPair(h.app, {
    seeking: { est_age: 5 },
    located: { est_age: 5 },
  });
  const opened = await openPair(h.app, candidateId);
  assert.equal(opened.body.sensitive_reason, "minor"); // 未成年先命中
  // 对一对成年当事人之间标记争议，验证独立路由
  const adult = await registerPair(h.app, {
    seeking: { person_name: "成年甲", est_age: 30, last_contact_place: "仓库", clues: [{ type: "scar", value: "刀疤" }] },
    located: { person_name: "成年甲", est_age: 30, last_contact_place: "仓库", clues: [{ type: "scar", value: "刀疤" }] },
  });
  const adultArr = await openPair(h.app, adult.candidateId);
  await request(h.app)
    .post("/restrictions")
    .set("x-staff-id", "sp1")
    .send({ type: "custody_dispute", subject_report_id: adult.seekingId, counterparty_report_id: adult.locatedId });
  const row = h.db.prepare("SELECT * FROM arrangements WHERE arrangement_id = ?").get(adultArr.body.arrangement_id);
  assert.equal(row.status, "in_review");
  assert.equal(row.sensitive_reason, "custody_dispute");
  h.close();
});
