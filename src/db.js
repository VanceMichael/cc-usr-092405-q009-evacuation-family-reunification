import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { sha256, nowIso } from "./util.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  site_id TEXT REFERENCES sites(id)
);

-- 失联/寻亲登记：仅保存最少身份线索
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  report_kind TEXT NOT NULL DEFAULT 'seek', -- seek=寻找亲属 / found=发现的人员
  person_name TEXT NOT NULL,
  approx_age INTEGER,
  age_band TEXT NOT NULL DEFAULT 'unknown',
  distinguishing_marks TEXT NOT NULL DEFAULT '[]', -- JSON 数组，限 3 条
  relationship TEXT NOT NULL,
  relationship_detail TEXT,                      -- 如：邻居临时代看
  reporter_name TEXT NOT NULL,
  contact_phone TEXT,
  contact_windows TEXT NOT NULL DEFAULT '[]',    -- JSON：可联系时段
  last_contact_place TEXT NOT NULL,
  last_contact_at TEXT,
  flags TEXT NOT NULL DEFAULT '[]',              -- JSON：restricted_contact / custody_dispute
  subject_status TEXT NOT NULL DEFAULT 'missing',
  subject_site_id TEXT REFERENCES sites(id),     -- 当事人当前所在安置点（转移时更新）
  registering_site_id TEXT NOT NULL REFERENCES sites(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 离线设备流水：(device_id, seq) 唯一，用于识别重传
CREATE TABLE IF NOT EXISTS device_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  registration_id TEXT,
  UNIQUE(device_id, seq)
);

-- 疑似同一人候选（不自动合并）
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  registration_a TEXT NOT NULL REFERENCES registrations(id),
  registration_b TEXT NOT NULL REFERENCES registrations(id),
  score INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  basis TEXT NOT NULL,           -- JSON：置信依据
  status TEXT NOT NULL DEFAULT 'proposed',
  active_arrangement_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(registration_a, registration_b)
);

-- 团聚安排
CREATE TABLE IF NOT EXISTS arrangements (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  route TEXT NOT NULL,
  state TEXT NOT NULL,
  route_reasons TEXT NOT NULL DEFAULT '[]', -- 进入专门复核的原因
  -- 双方分别确认（短期凭据，存哈希）
  side_a_registration_id TEXT NOT NULL,
  side_b_registration_id TEXT NOT NULL,
  confirm_deadline TEXT,
  token_a_hash TEXT, token_a_issued_at TEXT, confirmed_a_at TEXT,
  token_b_hash TEXT, token_b_issued_at TEXT, confirmed_b_at TEXT,
  -- 专门复核
  specialist_id TEXT, review_note TEXT, reviewed_at TEXT,
  -- 生效与会合
  winning_site_id TEXT REFERENCES sites(id),
  rendezvous_plan TEXT,           -- JSON：会合必要信息
  rendezvous_token_hash TEXT, rendezvous_expires_at TEXT, rendezvous_reissued INTEGER DEFAULT 0,
  token_epoch INTEGER NOT NULL DEFAULT 0, -- 调整/重路由后旧凭据立即失效
  -- 释放（拒绝/超时等；不删除）
  release_reason TEXT, released_at TEXT,
  completed_at TEXT,
  risk_note TEXT,                 -- 完成后到达的风险说明（追加）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arrangement_events (
  id TEXT PRIMARY KEY,
  arrangement_id TEXT NOT NULL REFERENCES arrangements(id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);

-- 只追加审计日志（哈希链）
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
`;

const SEED = `
INSERT OR IGNORE INTO sites (id, name) VALUES
  ('site-a', '一号安置点'),
  ('site-b', '二号安置点'),
  ('site-c', '三号安置点');
INSERT OR IGNORE INTO actors (id, name, role, site_id) VALUES
  ('worker-a', '甲点联络员', 'worker', 'site-a'),
  ('worker-b', '乙点联络员', 'worker', 'site-b'),
  ('worker-c', '丙点联络员', 'worker', 'site-c'),
  ('specialist-1', '保护复核员一', 'specialist', NULL),
  ('specialist-2', '保护复核员二', 'specialist', NULL),
  ('commander-1', '值班指挥', 'commander', NULL),
  ('auditor-1', '授权审计员', 'auditor', NULL);
`;

export function openDatabase({ dbPath = ".data/muster.sqlite" } = {}) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec(SEED);
  return db;
}

/** 审计：追加一条带哈希链的记录 */
export function appendAudit(db, { actorId = null, action, entityType = null, entityId = null, detail = {} }) {
  const row = auditCount(db) === 0 ? undefined : lastAudit(db);
  const prevHash = row?.hash ?? "GENESIS";
  const at = nowIso();
  const detailJson = JSON.stringify(detail ?? {});
  // 哈希输入与 verifyAuditChain 保持完全一致：detail 以其 JSON 字符串参与序列化
  const body = JSON.stringify({ at, actor_id: actorId, action, entity_type: entityType, entity_id: entityId, detail: detailJson });
  const hash = sha256(prevHash + body);
  db.prepare(
    `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, detail, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(at, actorId, action, entityType, entityId, detailJson, prevHash, hash);
  return db.prepare("SELECT * FROM audit_log WHERE hash = ?").get(hash);
}

export function auditCount(db) {
  return db.prepare("SELECT COUNT(*) c FROM audit_log").get().c;
}
export function lastAudit(db) {
  return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get();
}

/** 校验审计哈希链完整性 */
export function verifyAuditChain(db) {
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY id ASC").all();
  let prev = "GENESIS";
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, broken_at: r.id, reason: "prev_hash_mismatch", count: rows.length };
    const body = JSON.stringify({
      at: r.at, actor_id: r.actor_id, action: r.action,
      entity_type: r.entity_type, entity_id: r.entity_id, detail: r.detail,
    });
    if (sha256(prev + body) !== r.hash) return { ok: false, broken_at: r.id, reason: "hash_mismatch", count: rows.length };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}

