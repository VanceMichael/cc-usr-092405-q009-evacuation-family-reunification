import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";

export const BASE_TIME = 1_700_000_000_000;

// 每个用例独立内存库 + 可控时钟；sweepIntervalMs=0 关闭后台扫描，由用例显式触发
export function harness({ ttl, sweepIntervalMs = 0 } = {}) {
  let t = BASE_TIME;
  const db = openDb(":memory:");
  const app = createApp({
    db,
    clock: () => t,
    ttl: ttl ?? { confirm: 60_000, credential: 120_000 },
    sweepIntervalMs,
  });
  return {
    app,
    db,
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    close: () => db.close(),
  };
}

export function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "muster-"));
  return { dir, file: join(dir, "muster.db") };
}

export function cleanupTemp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// 同步注册一条登记，返回 {status, body}
export async function postReport(app, staffId, body) {
  const { default: request } = await import("supertest");
  return request(app).post("/reports").set("x-staff-id", staffId).send(body);
}

// 构造一对足以达到高置信、且含强佐证的寻人与在场登记
export async function registerPair(
  app,
  { seeking = {}, located = {}, seekingStaff = "w1", locatedStaff = "w1" } = {}
) {
  const { default: request } = await import("supertest");
  const sBody = {
    side: "seeking",
    person_name: "李华",
    est_age: 34,
    gender: "女",
    last_contact_place: "三号桥东侧避难楼梯",
    relationship_decl: "配偶",
    clues: [{ type: "tattoo", value: "手腕玫瑰纹身" }],
    contact_windows: [{ from: "09:00", to: "17:00", channel: "radio-7" }],
    ...seeking,
  };
  const lBody = {
    side: "located",
    person_name: "李华",
    est_age: 34,
    gender: "女",
    last_contact_place: "三号桥东侧避难楼梯",
    clues: [{ type: "tattoo", value: "手腕玫瑰纹身" }],
    ...located,
  };
  const s = await request(app).post("/reports").set("x-staff-id", seekingStaff).send(sBody);
  const l = await request(app).post("/reports").set("x-staff-id", locatedStaff).send(lBody);
  // 在场登记会与所有寻人记录形成候选，必须按本对的双方 report_id 精确选取
  const row = dbForApp(app)
    .prepare(
      "SELECT candidate_id FROM match_candidates WHERE seeking_report_id = ? AND located_report_id = ?"
    )
    .get(s.body.report_id, l.body.report_id);
  return { seekingId: s.body.report_id, locatedId: l.body.report_id, candidateId: row?.candidate_id };
}

// createApp 把 db 挂在 app.db 上
function dbForApp(app) {
  return app.db;
}

export async function confirmSide(app, arrangementId, side, staffId = "w1") {
  const { default: request } = await import("supertest");
  return request(app).post(`/arrangements/${arrangementId}/confirm`).set("x-staff-id", staffId).send({ side });
}

export async function openPair(app, candidateId, staffId = "w1") {
  const { default: request } = await import("supertest");
  return request(app)
    .post(`/candidates/${candidateId}/arrangements`)
    .set("x-staff-id", staffId)
    .send({});
}

export async function bothConfirm(app, arrangementId) {
  const { default: request } = await import("supertest");
  await request(app).post(`/arrangements/${arrangementId}/confirm`).set("x-staff-id", "w1").send({ side: "seeking" });
  return request(app).post(`/arrangements/${arrangementId}/confirm`).set("x-staff-id", "w1").send({ side: "located" });
}
