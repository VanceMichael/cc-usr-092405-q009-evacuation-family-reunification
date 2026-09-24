import crypto from "node:crypto";

export function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

export function newId() {
  return crypto.randomUUID();
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** 姓名/地名归一化：小写、去标点、压缩空白（不删除 CJK） */
export function normalizeText(value) {
  if (value == null) return "";
  return String(value)
    .toLowerCase()
    .replace(/[·・,，.。!！?？;；:：'’"“”()（）\[\]{}、\-_/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 粗粒度地名：取最小行政/片区描述（截断到首个门牌号式细节之前） */
export function coarsePlace(value) {
  if (!value) return "";
  const text = String(value).trim();
  const cut = text.search(/\d+号|\d+栋|\d+幢|楼|室|巷|弄/);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

function isCjk(value) {
  return /[一-鿿]/.test(value);
}

/** 名单脱敏：仅保留首字 */
export function maskName(value) {
  if (!value) return "";
  const text = String(value).trim();
  const first = [...text][0] ?? "";
  return isCjk(text) ? `${first}**` : `${first}***`;
}

export function maskPhone(value) {
  if (!value) return "";
  const digits = String(value).replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
}

/** 交集窗口：联系时段仅在安排会合时使用 */
export function intersectWindows(a = [], b = []) {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      const from = x.from > y.from ? x.from : y.from;
      const to = x.to < y.to ? x.to : y.to;
      if (from < to) out.push({ from, to });
    }
  }
  return out;
}
