import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { harness } from "./helpers.js";

// 场景：同一位寻亲家属，在 S1、S2 各有一条疑似在场登记。
// 两处几乎同时发起安排时，只能有一处生效。
test("两个安置点同时确认同一寻亲者：只有一处安排生效", async () => {
  const h = harness();
  const seeking = await request(h.app)
    .post("/reports")
    .set("x-staff-id", "w1")
    .send({
      side: "seeking",
      person_name: "许桥",
      est_age: 44,
      last_contact_place: "跨江大桥南端",
      clues: [{ type: "medal", value: "旧军功牌编号 07" }],
    });

  const locatedS1 = await request(h.app)
    .post("/reports")
    .set("x-staff-id", "w1")
    .send({
      side: "located",
      person_name: "许桥",
      est_age: 44,
      last_contact_place: "跨江大桥南端",
      clues: [{ type: "medal", value: "旧军功牌编号 07" }],
    });
  const locatedS2 = await request(h.app)
    .post("/reports")
    .set("x-staff-id", "w2")
    .send({
      side: "located",
      person_name: "许桥",
      est_age: 44,
      last_contact_place: "跨江大桥南端",
      clues: [{ type: "medal", value: "旧军功牌编号 07" }],
    });

  const pick = (locatedId) =>
    h.db
      .prepare(
        "SELECT candidate_id FROM match_candidates WHERE seeking_report_id = ? AND located_report_id = ?"
      )
      .get(seeking.body.report_id, locatedId).candidate_id;
  const c1 = pick(locatedS1.body.report_id);
  const c2 = pick(locatedS2.body.report_id);

  // S2 工作人员确实能看到涉及本点的候选
  const s2List = await request(h.app).get("/candidates").set("x-staff-id", "w2");
  assert.ok(s2List.body.candidates.some((c) => c.candidate_id === c2));

  const first = await request(h.app).post(`/candidates/${c1}/arrangements`).set("x-staff-id", "w1").send({});
  assert.equal(first.status, 201, first.text);

  const second = await request(h.app).post(`/candidates/${c2}/arrangements`).set("x-staff-id", "w2").send({});
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "arrangement_active_elsewhere");

  // S1 拒绝后释放，S2 才能发起
  await request(h.app).post(`/arrangements/${first.body.arrangement_id}/reject`).set("x-staff-id", "w1").send({ side: "seeking" });
  const retry = await request(h.app).post(`/candidates/${c2}/arrangements`).set("x-staff-id", "w2").send({});
  assert.equal(retry.status, 201, retry.text);
  // 会合归属在场登记所在点 S2
  const arr = h.db.prepare("SELECT owning_site_id FROM arrangements WHERE arrangement_id = ?").get(retry.body.arrangement_id);
  assert.equal(arr.owning_site_id, "S2");
  h.close();
});

test("工作人员不能为其他安置点独占的候选直接发起安排", async () => {
  const h = harness();
  // 寻人与在场均在 S2
  await request(h.app).post("/reports").set("x-staff-id", "w2").send({
    side: "seeking",
    person_name: "何岚",
    est_age: 28,
    last_contact_place: "西客站",
    clues: [{ type: "bracelet", value: "红绳手链" }],
  });
  const l = await request(h.app).post("/reports").set("x-staff-id", "w2").send({
    side: "located",
    person_name: "何岚",
    est_age: 28,
    last_contact_place: "西客站",
    clues: [{ type: "bracelet", value: "红绳手链" }],
  });
  const forbidden = await request(h.app)
    .post(`/candidates/${l.body.candidate_ids[0]}/arrangements`)
    .set("x-staff-id", "w1")
    .send({});
  assert.equal(forbidden.status, 403);
  h.close();
});
