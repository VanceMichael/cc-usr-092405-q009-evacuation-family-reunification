import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/server.js";
import { openDb } from "../src/db.js";

test("健康检查返回清点服务标识", async () => {
  const app = createApp({ db: openDb(":memory:"), sweepIntervalMs: 0 });
  const response = await request(app).get("/health");
  assert.equal(response.status, 200);
  assert.equal(response.body.service, "evacuation-muster");
});

test("未知工作人员身份被拒绝", async () => {
  const app = createApp({ db: openDb(":memory:"), sweepIntervalMs: 0 });
  const response = await request(app).get("/candidates").set("x-staff-id", "nobody");
  assert.equal(response.status, 401);
});
