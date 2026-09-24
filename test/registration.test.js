import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { harness, postReport, tempDbPath, cleanupTemp } from "./helpers.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";

test("登记保存最少身份线索、关系声明、最后接触地点与可联系时段", async () => {
  const h = harness();
  const res = await postReport(h.app, "w1", {
    side: "seeking",
    person_name: "赵芳",
    est_age: 29,
    gender: "女",
    relationship_decl: "姐姐",
    last_contact_place: "城北市场东门",
    clues: [{ type: "birthmark", value: "右臂红痣" }],
    contact_windows: [{ from: "08:00", to: "12:00", channel: "radio-3" }],
  });
  assert.equal(res.status, 201, res.text);
  const row = h.db.prepare("SELECT * FROM reports WHERE report_id = ?").get(res.body.report_id);
  assert.equal(row.relationship_decl, "姐姐");
  assert.equal(row.last_contact_place, "城北市场东门");
  assert.deepEqual(JSON.parse(row.clues_json), [{ type: "birthmark", value: "右臂红痣" }]);
  assert.equal(JSON.parse(row.contact_windows_json)[0].channel, "radio-3");
  h.close();
});

test("重复登记产生独立报告，绝不自动合并", async () => {
  const h = harness();
  const a = await postReport(h.app, "w1", { side: "seeking", person_name: "同名者", est_age: 40 });
  const b = await postReport(h.app, "w2", { side: "seeking", person_name: "同名者", est_age: 40 });
  assert.notEqual(a.body.report_id, b.body.report_id);
  const n = h.db.prepare("SELECT COUNT(*) AS n FROM reports").get().n;
  assert.equal(n, 2);
  const merged = h.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%merged%'")
    .all();
  assert.equal(merged.length, 0);
  h.close();
});

test("线索数量受限（最少必要原则）", async () => {
  const h = harness();
  const res = await postReport(h.app, "w1", {
    side: "located",
    person_name: "钱七",
    clues: Array.from({ length: 6 }, (_, i) => ({ type: "note", value: `线索${i}` })),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "too_many_clues");
  h.close();
});

test("离线设备重传：相同流水号与内容返回首次结果，不产生重复登记", async () => {
  const h = harness();
  const payload = [
    {
      type: "register_report",
      report: { side: "located", person_name: "离线娃", est_age: 9, last_contact_place: "二小" },
    },
  ];
  const first = await request(h.app).post("/sync").set("x-staff-id", "w1").send({
    device_id: "dev-A",
    seq: 1,
    events: payload,
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.replayed, false);

  const second = await request(h.app).post("/sync").set("x-staff-id", "w1").send({
    device_id: "dev-A",
    seq: 1,
    events: payload,
  });
  assert.equal(second.body.replayed, true);
  assert.deepEqual(second.body.results, first.body.results);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE person_name = '离线娃'").get().n, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM device_events").get().n, 1);
  h.close();
});

test("同一流水号内容不同被拒绝", async () => {
  const h = harness();
  const mk = (name) => [{ type: "register_report", report: { side: "located", person_name: name } }];
  await request(h.app).post("/sync").set("x-staff-id", "w1").send({ device_id: "dev-B", seq: 1, events: mk("甲") });
  const conflict = await request(h.app).post("/sync").set("x-staff-id", "w1").send({
    device_id: "dev-B",
    seq: 1,
    events: mk("乙"),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "seq_payload_conflict");
  h.close();
});

test("流水号必须顺序提交", async () => {
  const h = harness();
  const events = [{ type: "register_report", report: { side: "located", person_name: "丙" } }];
  const r2 = await request(h.app).post("/sync").set("x-staff-id", "w1").send({
    device_id: "dev-C",
    seq: 2,
    events,
  });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, "out_of_order");
  h.close();
});

test("多设备各自独立维护流水", async () => {
  const h = harness();
  const ev = (name) => [{ type: "register_report", report: { side: "located", person_name: name } }];
  for (const [device, name] of [["d1", "设备一"], ["d2", "设备二"]]) {
    const r = await request(h.app).post("/sync").set("x-staff-id", "w1").send({ device_id: device, seq: 1, events: ev(name) });
    assert.equal(r.status, 200, r.text);
  }
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM reports").get().n, 2);
  h.close();
});

test("系统重启后从持久化数据库继续：流水与凭据状态保留", async () => {
  const { dir, file } = tempDbPath();
  try {
    const db1 = openDb(file);
    const app1 = createApp({ db: db1, sweepIntervalMs: 0 });
    const res = await request(app1)
      .post("/sync")
      .set("x-staff-id", "w1")
      .send({ device_id: "dev-persist", seq: 1, events: [{ type: "register_report", report: { side: "located", person_name: "持久" } }] });
    assert.equal(res.status, 200);
    db1.close();

    const db2 = openDb(file);
    const app2 = createApp({ db: db2, sweepIntervalMs: 0 });
    const replay = await request(app2)
      .post("/sync")
      .set("x-staff-id", "w1")
      .send({ device_id: "dev-persist", seq: 1, events: [{ type: "register_report", report: { side: "located", person_name: "持久" } }] });
    assert.equal(replay.body.replayed, true);
    db2.close();
  } finally {
    cleanupTemp(dir);
  }
});
