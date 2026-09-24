import { openDatabase } from "../src/db.js";
import { createService } from "../src/service.js";

export const BASE_TIME = Date.parse("2026-09-24T10:00:00Z");

export function makeHarness({ confirmTtlMs = 30 * 60 * 1000, rvTtlMs = 2 * 3600 * 1000 } = {}) {
  let now = BASE_TIME;
  const clock = () => now;
  const db = openDatabase({ dbPath: ":memory:" });
  const service = createService(db, { clock, confirmTtlMs, rendezvousTtlMs: rvTtlMs });
  return {
    db, service, clock,
    advance: (ms) => { now += ms; },
    setTime: (iso) => { now = Date.parse(iso); },
    wa: service.getActor("worker-a"),
    wb: service.getActor("worker-b"),
    wc: service.getActor("worker-c"),
    sp: service.getActor("specialist-1"),
    sp2: service.getActor("specialist-2"),
    cmd: service.getActor("commander-1"),
    aud: service.getActor("auditor-1"),
  };
}

export const adultPair = {
  seek: {
    report_kind: "seek", person_name: "张伟", approx_age: 34, relationship: "spouse",
    reporter_name: "李梅", contact_phone: "13800001111",
    contact_windows: [{ from: "2026-09-24T12:00:00Z", to: "2026-09-24T18:00:00Z" }],
    last_contact_place: "城北体育馆3号门", last_contact_at: "2026-09-23T08:00:00Z",
    distinguishing_marks: ["左臂疤痕"],
  },
  found: {
    report_kind: "found", person_name: "张伟", approx_age: 35, relationship: "self",
    reporter_name: "张伟", contact_phone: "13800002222",
    contact_windows: [{ from: "2026-09-24T14:00:00Z", to: "2026-09-24T20:00:00Z" }],
    last_contact_place: "城北体育馆", last_contact_at: "2026-09-23T09:00:00Z",
    distinguishing_marks: ["左臂疤痕"],
  },
};
