import Database from "better-sqlite3";
import { Role, EvacStatus } from "./contracts.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sites (
  site_id   TEXT PRIMARY KEY,
  name      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  staff_id  TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  role      TEXT NOT NULL,
  site_id   TEXT REFERENCES sites(site_id) -- 仅 worker 绑定安置点；其余角色为全局
);

-- 离线设备流水：(device_id, seq) 唯一，重传命中原应答
CREATE TABLE IF NOT EXISTS device_events (
  device_id     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (device_id, seq)
);

CREATE TABLE IF NOT EXISTS device_cursor (
  device_id  TEXT PRIMARY KEY,
  site_id    TEXT NOT NULL REFERENCES sites(site_id),
  next_seq   INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- 最少身份线索：登记本体。重复登记各是独立 report，绝不合并
CREATE TABLE IF NOT EXISTS reports (
  report_id           TEXT PRIMARY KEY,
  side                TEXT NOT NULL,             -- seeking | located
  site_id             TEXT NOT NULL REFERENCES sites(site_id),
  person_name         TEXT NOT NULL,
  alias_name          TEXT,
  est_age             INTEGER,
  age_band            TEXT,
  gender              TEXT,
  minor_flag          INTEGER NOT NULL DEFAULT 0,
  clues_json          TEXT NOT NULL DEFAULT '[]', -- 最少身份线索 [{type,value}]，上限见 CLUE_LIMITS
  relationship_decl   TEXT NOT NULL DEFAULT '',   -- 关系声明（自由文本，简短）
  last_contact_place  TEXT NOT NULL DEFAULT '',
  contact_windows_json TEXT NOT NULL DEFAULT '[]',-- 可联系时段 [{from,to,channel}]
  evac_status         TEXT NOT NULL DEFAULT '${EvacStatus.UNKNOWN}',
  current_site_id     TEXT REFERENCES sites(site_id),
  source_device_id    TEXT,
  source_seq          INTEGER,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_side ON reports(side);
CREATE INDEX IF NOT EXISTS idx_reports_site ON reports(site_id);

-- 限制接触 / 监护争议，主体为某位被登记人
CREATE TABLE IF NOT EXISTS restrictions (
  restriction_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_report_id     TEXT NOT NULL REFERENCES reports(report_id),
  counterparty_report_id TEXT REFERENCES reports(report_id),
  type                  TEXT NOT NULL,
  detail                TEXT NOT NULL DEFAULT '',
  active                INTEGER NOT NULL DEFAULT 1,
  issued_by             TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_restrictions_subject ON restrictions(subject_report_id, active);

-- 疑似同一人的候选；factors_json 是置信依据，状态永不代表“人已合并”
CREATE TABLE IF NOT EXISTS match_candidates (
  candidate_id        TEXT PRIMARY KEY,
  seeking_report_id   TEXT NOT NULL REFERENCES reports(report_id),
  located_report_id   TEXT NOT NULL REFERENCES reports(report_id),
  score               INTEGER NOT NULL,
  confidence          TEXT NOT NULL,
  factors_json        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open', -- open | opened | dismissed
  created_at          TEXT NOT NULL,
  UNIQUE (seeking_report_id, located_report_id)
);

CREATE TABLE IF NOT EXISTS arrangements (
  arrangement_id              TEXT PRIMARY KEY,
  candidate_id                TEXT NOT NULL REFERENCES match_candidates(candidate_id),
  seeking_report_id           TEXT NOT NULL REFERENCES reports(report_id),
  located_report_id           TEXT NOT NULL REFERENCES reports(report_id),
  owning_site_id              TEXT NOT NULL REFERENCES sites(site_id),
  status                      TEXT NOT NULL,
  sensitive_reason            TEXT,  -- minor | custody_dispute | contact_restriction
  release_reason              TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  confirm_deadline            TEXT,  -- pending 双方确认截止
  credential_expires_at       TEXT,  -- 凭据/会合截止（墙上时钟，重启后继续计算）
  completed_at                TEXT,
  authorization_snapshot_json TEXT   -- 完成时冻结的当时授权
);
CREATE INDEX IF NOT EXISTS idx_arr_status ON arrangements(status);
CREATE INDEX IF NOT EXISTS idx_arr_site ON arrangements(owning_site_id, status);

CREATE TABLE IF NOT EXISTS arrangement_confirmations (
  arrangement_id TEXT NOT NULL REFERENCES arrangements(arrangement_id),
  side           TEXT NOT NULL,
  staff_id       TEXT NOT NULL,
  at             TEXT NOT NULL,
  PRIMARY KEY (arrangement_id, side)
);

CREATE TABLE IF NOT EXISTS arrangement_reviews (
  review_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  arrangement_id TEXT NOT NULL REFERENCES arrangements(arrangement_id),
  reviewer_id    TEXT NOT NULL,
  decision       TEXT NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  credential_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  arrangement_id   TEXT NOT NULL REFERENCES arrangements(arrangement_id),
  code             TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'valid', -- valid | void
  meeting_info_json TEXT NOT NULL,                -- 仅会合必要信息
  issued_at        TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  voided_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_cred_arr ON credentials(arrangement_id);

-- 生效中的独占占用：同一 report（同一登记线索主体）只允许一处安排生效
CREATE TABLE IF NOT EXISTS active_claims (
  report_id      TEXT PRIMARY KEY REFERENCES reports(report_id),
  arrangement_id TEXT NOT NULL REFERENCES arrangements(arrangement_id),
  granted_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_notes (
  risk_note_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  arrangement_id TEXT NOT NULL REFERENCES arrangements(arrangement_id),
  kind           TEXT NOT NULL, -- transfer | evac_correction | new_restriction
  note           TEXT NOT NULL,
  staff_id       TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- 审计轨迹：敏感信息访问、匹配重建、确认过程全部留痕
CREATE TABLE IF NOT EXISTS audit_events (
  audit_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id);
`;

function seed(db) {
  const insertSite = db.prepare("INSERT OR IGNORE INTO sites (site_id, name) VALUES (?, ?)");
  insertSite.run("S1", "江畔安置点");
  insertSite.run("S2", "城西安置点");

  const insertStaff = db.prepare(
    "INSERT OR IGNORE INTO staff (staff_id, name, role, site_id) VALUES (?, ?, ?, ?)"
  );
  insertStaff.run("w1", "李联络", Role.WORKER, "S1");
  insertStaff.run("w2", "王联络", Role.WORKER, "S2");
  insertStaff.run("sp1", "周专员", Role.SPECIALIST, null);
  insertStaff.run("cmd1", "指挥席值班", Role.COMMANDER, null);
  insertStaff.run("aud1", "审计员", Role.AUDITOR, null);
}

export function openDb(filename = ":memory:", { shouldSeed = true } = {}) {
  const db = new Database(filename);
  db.exec(SCHEMA);
  if (shouldSeed) seed(db);
  return db;
}
