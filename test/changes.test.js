import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { harness, registerPair, openPair, confirmSide } from "./helpers.js";

test("人员转移：待确认安排释放并作废，候选重新开放，安排以 released 留存", async () => {
  const h = harness();
  const { candidateId, locatedId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  await confirmSide(h.app, opened.body.arrangement_id, "seeking");

  const transfer = await request(h.app)
    .post(`/reports/${locatedId}/transfer`)
    .set("x-staff-id", "w1")
    .send({ to_site_id: "S2" });
  assert.equal(transfer.status, 200, transfer.text);

  const arr = h.db.prepare("SELECT * FROM arrangements WHERE arrangement_id = ?").get(opened.body.arrangement_id);
  assert.equal(arr.status, "released");
  assert.equal(arr.release_reason, "transfer");
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM active_claims").get().n, 0);
  assert.equal(h.db.prepare("SELECT status FROM match_candidates WHERE candidate_id = ?").get(candidateId).status, "open");

  const report = h.db.prepare("SELECT evac_status, current_site_id, version FROM reports WHERE report_id = ?").get(locatedId);
  assert.equal(report.evac_status, "in_transit");
  assert.equal(report.current_site_id, "S2");
  assert.equal(report.version, 2);
  h.close();
});

test("撤离状态更正：凭据已签发的安排被释放且凭据作废", async () => {
  const h = harness();
  const { candidateId, seekingId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  await confirmSide(h.app, opened.body.arrangement_id, "seeking");
  await confirmSide(h.app, opened.body.arrangement_id, "located");

  const fix = await request(h.app)
    .post(`/reports/${seekingId}/evac-correction`)
    .set("x-staff-id", "w1")
    .send({ evac_status: "hospital" });
  assert.equal(fix.status, 200, fix.text);

  const arr = h.db.prepare("SELECT * FROM arrangements WHERE arrangement_id = ?").get(opened.body.arrangement_id);
  assert.equal(arr.status, "released");
  assert.equal(arr.release_reason, "evac_correction");
  const valid = h.db
    .prepare("SELECT COUNT(*) AS n FROM credentials WHERE arrangement_id = ? AND status = 'valid'")
    .get(opened.body.arrangement_id).n;
  assert.equal(valid, 0);
  h.close();
});

test("转移发生在团聚完成后：完成状态与授权保留，追加风险说明", async () => {
  const h = harness();
  const { candidateId, locatedId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  await confirmSide(h.app, opened.body.arrangement_id, "seeking");
  await confirmSide(h.app, opened.body.arrangement_id, "located");
  await request(h.app)
    .post(`/arrangements/${opened.body.arrangement_id}/complete`)
    .set("x-staff-id", "w1")
    .send({});

  const transfer = await request(h.app)
    .post(`/reports/${locatedId}/transfer`)
    .set("x-staff-id", "w1")
    .send({ to_site_id: "S2" });
  assert.equal(transfer.status, 200);

  const arr = h.db.prepare("SELECT * FROM arrangements WHERE arrangement_id = ?").get(opened.body.arrangement_id);
  assert.equal(arr.status, "completed");
  assert.ok(arr.authorization_snapshot_json);
  const note = h.db
    .prepare("SELECT kind, note FROM risk_notes WHERE arrangement_id = ?")
    .get(opened.body.arrangement_id);
  assert.equal(note.kind, "transfer");
  assert.match(note.note, /城西安置点/);
  h.close();
});

test("释放后可基于同一候选重新发起安排（原申请仍在）", async () => {
  const h = harness();
  const { candidateId, locatedId } = await registerPair(h.app);
  const opened = await openPair(h.app, candidateId);
  await request(h.app).post(`/reports/${locatedId}/transfer`).set("x-staff-id", "w1").send({ to_site_id: "S2" });
  assert.equal(h.db.prepare("SELECT status FROM arrangements WHERE arrangement_id = ?").get(opened.body.arrangement_id).status, "released");

  // 人员抵达 S2 后状态更新
  await request(h.app).post(`/reports/${locatedId}/evac-correction`).set("x-staff-id", "w2").send({
    evac_status: "on_site",
    current_site_id: "S2",
  });
  const reopened = await openPair(h.app, candidateId, "w1");
  assert.equal(reopened.status, 201, reopened.text);
  assert.equal(reopened.body.status, "pending");
  h.close();
});

test("重启恢复：凭据有效期按墙上时钟继续，过期在重启扫描后立即生效", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb: open } = await import("../src/db.js");
  const dir = mkdtempSync(join(tmpdir(), "muster-restart-"));
  const file = join(dir, "muster.db");
  try {
    let base = 1_700_000_000_000;
    const db1 = open(file);
    const app1 = (
      await import("../src/server.js")
    ).createApp({ db: db1, clock: () => base, ttl: { confirm: 60_000, credential: 120_000 }, sweepIntervalMs: 0 });
    const pair = await registerPair(app1);
    const opened = await openPair(app1, pair.candidateId);
    await confirmSide(app1, opened.body.arrangement_id, "seeking");
    await confirmSide(app1, opened.body.arrangement_id, "located");
    const expiresAt = (
      await request(app1).get(`/arrangements/${opened.body.arrangement_id}/credential`).set("x-staff-id", "w1")
    ).body.expires_at;
    db1.close();

    // 重启，时钟已越过凭据到期时间
    base += 200_000;
    const db2 = open(file);
    const app2 = (
      await import("../src/server.js")
    ).createApp({ db: db2, clock: () => base, ttl: { confirm: 60_000, credential: 120_000 }, sweepIntervalMs: 0 });
    const arr = db2.prepare("SELECT status FROM arrangements WHERE arrangement_id = ?").get(opened.body.arrangement_id);
    assert.equal(arr.status, "expired"); // createApp 启动即扫描
    assert.ok(Date.parse(expiresAt) < base);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
