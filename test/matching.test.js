import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { harness, postReport } from "./helpers.js";
import { scorePair, isNameOnly, hasStrongCorroboration, normalizeText } from "../src/matching.js";

test("匹配输出带分值、置信级别与因子依据", async () => {
  const h = harness();
  await postReport(h.app, "w1", {
    side: "seeking",
    person_name: "孙丽",
    est_age: 31,
    gender: "女",
    last_contact_place: "西河堤",
    clues: [{ type: "glasses", value: "黑框眼镜" }],
  });
  const res = await postReport(h.app, "w1", {
    side: "located",
    person_name: "孙丽",
    est_age: 31,
    gender: "女",
    last_contact_place: "西河堤",
    clues: [{ type: "glasses", value: "黑框眼镜" }],
  });
  assert.equal(res.body.candidate_ids.length, 1);
  const list = await request(h.app).get("/candidates").set("x-staff-id", "w1");
  const c = list.body.candidates[0];
  assert.equal(c.confidence, "high");
  const factorNames = c.factors.map((f) => f.factor);
  assert.ok(factorNames.includes("name_exact"));
  assert.ok(factorNames.includes("place_exact"));
  assert.ok(factorNames.includes("shared_clue"));
  h.close();
});

test("仅凭姓名（最多叠加年龄/性别弱属性）：形成候选但不可安排见面", async () => {
  const h = harness();
  await postReport(h.app, "w1", { side: "seeking", person_name: "周强", est_age: 50, gender: "男" });
  await postReport(h.app, "w1", { side: "located", person_name: "周强", est_age: 50, gender: "男" });
  const list = await request(h.app).get("/candidates").set("x-staff-id", "w1");
  assert.equal(list.body.candidates.length, 1);
  const c = list.body.candidates[0];
  // 同龄同性别属于人口学弱属性；关键是不存在任何强佐证
  assert.equal(hasStrongCorroboration(c.factors), false);

  const open = await request(h.app)
    .post(`/candidates/${c.candidate_id}/arrangements`)
    .set("x-staff-id", "w1")
    .send({});
  assert.equal(open.status, 422);
  assert.equal(open.body.error, "name_only_candidate");
  h.close();
});

test("共享名字片段与年龄段只形成低置信候选，且不会自动合并", async () => {
  const h = harness();
  await postReport(h.app, "w1", { side: "located", person_name: "郑晓敏", est_age: 70 });
  await postReport(h.app, "w1", { side: "seeking", person_name: "吴晓敏", est_age: 70 });
  const list = await request(h.app).get("/candidates").set("x-staff-id", "w1");
  assert.equal(list.body.candidates.length, 1);
  assert.equal(list.body.candidates[0].confidence, "low");
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM reports").get().n, 2);
  h.close();
});

test("工作人员只看到脱敏视图：不暴露姓名全称、地点全称与联系方式", async () => {
  const h = harness();
  await postReport(h.app, "w1", {
    side: "seeking",
    person_name: "欧阳修远",
    est_age: 45,
    last_contact_place: "南门外长途汽车站",
    contact_windows: [{ from: "10:00", to: "12:00", channel: "sat-phone-9" }],
  });
  await postReport(h.app, "w1", {
    side: "located",
    person_name: "欧阳修远",
    est_age: 45,
    last_contact_place: "南门外长途汽车站",
    contact_windows: [{ from: "10:00", to: "12:00", channel: "sat-phone-9" }],
  });
  const list = await request(h.app).get("/candidates").set("x-staff-id", "w1");
  const s = list.body.candidates[0].seeking;
  assert.equal(s.masked_name, "欧**");
  assert.ok(!s.masked_name.includes("修远"));
  assert.equal(s.masked_last_place, "南门**");
  assert.equal(s.contact_windows[0].channel, "***");
  // 候选中不夹带原值字段
  assert.equal(s.person_name, undefined);
  assert.equal(s.clues, undefined);
  h.close();
});

test("S2 工作人员看不到仅涉及 S1 的候选", async () => {
  const h = harness();
  await postReport(h.app, "w1", { side: "seeking", person_name: "郑海", est_age: 30, last_contact_place: "码头" });
  await postReport(h.app, "w1", {
    side: "located",
    person_name: "郑海",
    est_age: 30,
    last_contact_place: "码头",
    clues: [{ type: "bag", value: "蓝色行李包" }],
  });
  const other = await request(h.app).get("/candidates").set("x-staff-id", "w2");
  assert.deepEqual(other.body.candidates, []);
  h.close();
});

test("匹配引擎单元：规范化忽略空白与大小写，别名命中给中等姓名依据", () => {
  assert.equal(normalizeText("  Zhang San "), normalizeText("zhangsan"));
  const aliasHit = scorePair(
    { person_name: "王小明", alias_name: "明明", clues: [], last_contact_place: "" },
    { person_name: "明明", alias_name: null, clues: [], last_contact_place: "" }
  );
  assert.equal(aliasHit.factors[0].factor, "name_alias");
  assert.ok(isNameOnly(aliasHit.factors));

  const nothing = scorePair(
    { person_name: "甲", clues: [], last_contact_place: "" },
    { person_name: "乙", clues: [], last_contact_place: "" }
  );
  assert.equal(nothing.confidence, null);
});
