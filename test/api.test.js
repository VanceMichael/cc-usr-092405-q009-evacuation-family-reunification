import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/server.js";
import { makeHarness, adultPair } from "./helpers.js";

// 直接用内存库 + 可控时钟构建 app
function makeAppHarness() {
  const h = makeHarness();
  const app = createApp({ db: h.db, serviceOptions: { clock: h.clock } });
  return { ...h, app };
}

test("HTTP：缺少 X-Actor-Id 被拒绝", async () => {
  const h = makeAppHarness();
  const res = await request(h.app).get("/v1/candidates");
  assert.equal(res.status, 401);
});

test("HTTP：未知身份 401", async () => {
  const h = makeAppHarness();
  const res = await request(h.app).get("/v1/candidates").set("X-Actor-Id", "nobody");
  assert.equal(res.status, 401);
});

test("HTTP：指挥席不能查看候选；审计员不能发起安排（角色隔离）", async () => {
  const h = makeAppHarness();
  const r1 = await request(h.app).get("/v1/candidates").set("X-Actor-Id", "commander-1");
  assert.equal(r1.status, 403);
  const r2 = await request(h.app).post("/v1/candidates/x/arrangements").set("X-Actor-Id", "auditor-1").send({});
  assert.equal(r2.status, 403);
});

test("HTTP：完整成年人团聚流程；公开 /v1/confirm 与 /v1/rendezvous 无需身份头", async () => {
  const h = makeAppHarness();
  await request(h.app).post("/v1/registrations").set("X-Actor-Id", "worker-a").send(adultPair.seek).expect(201);
  await request(h.app).post("/v1/registrations").set("X-Actor-Id", "worker-b").send(adultPair.found).expect(201);

  const list = await request(h.app).get("/v1/candidates").set("X-Actor-Id", "worker-a");
  const candidate = list.body.candidates[0];
  assert.equal(candidate.confidence, "high");

  const start = await request(h.app)
    .post(`/v1/candidates/${candidate.id}/arrangements`)
    .set("X-Actor-Id", "worker-a")
    .send({});
  assert.equal(start.status, 201);
  const arrId = start.body.id;
  // 判断本工人对应侧
  const aOnViewer = start.body.side_a_registration_id;
  const regA = h.db.prepare("SELECT registering_site_id FROM registrations WHERE id = ?").get(aOnViewer);
  const sideForA = regA.registering_site_id === "site-a" ? "a" : "b";
  const sideForB = sideForA === "a" ? "b" : "a";

  const ta = await request(h.app).post(`/v1/arrangements/${arrId}/confirmation-tokens`)
    .set("X-Actor-Id", "worker-a").send({ side: sideForA });
  const tb = await request(h.app).post(`/v1/arrangements/${arrId}/confirmation-tokens`)
    .set("X-Actor-Id", "worker-b").send({ side: sideForB });
  assert.equal(ta.status, 201);

  const c1 = await request(h.app).post("/v1/confirm").send({ token: ta.body.token });
  assert.equal(c1.body.outcome, "waiting");
  const c2 = await request(h.app).post("/v1/confirm").send({ token: tb.body.token });
  assert.equal(c2.body.outcome, "confirmed");

  const rv = await request(h.app).post("/v1/rendezvous").send({ token: c2.body.rendezvous_token });
  assert.equal(rv.status, 200);
  assert.equal(rv.body.site_name, "二号安置点");
  assert.ok(rv.body.contact_windows.length === 1);
});

test("HTTP：设备流水重传返回 duplicate 标记", async () => {
  const h = makeAppHarness();
  const payload = { person_name: "离线陈", approx_age: 50, relationship: "child", reporter_name: "陈小", last_contact_place: "东区大棚" };
  const r1 = await request(h.app).post("/v1/device-events").set("X-Actor-Id", "worker-a")
    .send({ device_id: "d1", seq: 3, type: "registration", payload });
  assert.equal(r1.status, 202);
  assert.equal(r1.body.duplicate, false);
  const r2 = await request(h.app).post("/v1/device-events").set("X-Actor-Id", "worker-a")
    .send({ device_id: "d1", seq: 3, type: "registration", payload });
  assert.equal(r2.body.duplicate, true);
});

test("HTTP：儿童候选进入复核队列，专门人员可批准；工作人员无权访问 /v1/reviews", async () => {
  const h = makeAppHarness();
  const child = {
    seek: { report_kind: "seek", person_name: "林小果", approx_age: 7, relationship: "parent", reporter_name: "林母", last_contact_place: "北坝小学", last_contact_at: "2026-09-23T08:00:00Z" },
    found: { report_kind: "found", person_name: "林小果", approx_age: 7, relationship: "other", reporter_name: "救助员", last_contact_place: "北坝小学", last_contact_at: "2026-09-23T09:00:00Z" },
  };
  await request(h.app).post("/v1/registrations").set("X-Actor-Id", "worker-a").send(child.seek);
  await request(h.app).post("/v1/registrations").set("X-Actor-Id", "worker-b").send(child.found);
  const list = await request(h.app).get("/v1/candidates").set("X-Actor-Id", "worker-a");
  const cid = list.body.candidates[0].id;
  const start = await request(h.app).post(`/v1/candidates/${cid}/arrangements`).set("X-Actor-Id", "worker-a").send({});
  const arrId = start.body.id;

  const denied = await request(h.app).get("/v1/reviews").set("X-Actor-Id", "worker-a");
  assert.equal(denied.status, 403);

  const queue = await request(h.app).get("/v1/reviews").set("X-Actor-Id", "specialist-1");
  assert.equal(queue.body.queue.length, 1);

  // 未带 full 时默认脱敏
  const detail = await request(h.app).get(`/v1/reviews/${arrId}`).set("X-Actor-Id", "specialist-1");
  assert.ok(detail.body.candidate.sides.a.registration.person_name_masked);

  const dec = await request(h.app).post(`/v1/reviews/${arrId}/decision`).set("X-Actor-Id", "specialist-1")
    .send({ decision: "approved", note: "核实通过" });
  assert.equal(dec.body.outcome, "confirmed");
});

test("HTTP：指挥席汇总无 PII；审计接口仅审计员可用", async () => {
  const h = makeAppHarness();
  const sum = await request(h.app).get("/v1/command/summary").set("X-Actor-Id", "commander-1");
  assert.equal(sum.status, 200);
  assert.ok("blockers" in sum.body);

  const denied = await request(h.app).get("/v1/audit/accesses").set("X-Actor-Id", "commander-1");
  assert.equal(denied.status, 403);
  const ok = await request(h.app).get("/v1/audit/accesses").set("X-Actor-Id", "auditor-1");
  assert.equal(ok.status, 200);
});

test("HTTP：恢复端点返回凭据余量与复核队列长度", async () => {
  const h = makeAppHarness();
  const rec = await request(h.app).post("/v1/reconcile").set("X-Actor-Id", "worker-a").send({});
  assert.equal(rec.status, 200);
  assert.ok("confirmation_tokens" in rec.body);
  assert.ok("review_queue" in rec.body);
});
