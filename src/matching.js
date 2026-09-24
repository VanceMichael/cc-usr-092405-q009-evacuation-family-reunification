import {
  Confidence,
  MatchFactor,
  SCORE_WEIGHTS as W,
  SCORE_THRESHOLDS as T,
  ageBandFor,
} from "./contracts.js";

// 纯函数匹配引擎：输入两条登记，输出分数、置信级别与因子证据。
// 设计约束：仅凭姓名相同最高 medium；任何级别都只是候选，不代表合并。

export function normalizeText(value) {
  if (value == null) return "";
  return String(value)
    .normalize("NFKC")
    .trim()
    .replace(/[\s　]+/g, "")
    .toLowerCase();
}

function nameTokens(name) {
  const n = normalizeText(name);
  if (!n) return [];
  // 中文名逐字与全名都作为可比对片段；拉丁名按词切
  const tokens = new Set([n]);
  if (/[a-z]/.test(n)) {
    for (const part of n.split(/[\s,，·.]+/).filter((p) => p.length >= 2)) tokens.add(part);
  } else if (n.length >= 2) {
    // 单字过短不做“部分重合”，避免“伟”“强”之类误配；取长度>=2 的连续片段
    for (let len = 2; len < n.length; len++) {
      for (let i = 0; i + len <= n.length; i++) tokens.add(n.slice(i, i + len));
    }
  }
  return [...tokens];
}

function compareNames(seekingName, seekingAlias, locatedName, locatedAlias) {
  const s = normalizeText(seekingName);
  const l = normalizeText(locatedName);
  if (!s || !l) return [];

  const factors = [];
  const sAliases = [normalizeText(seekingAlias)].filter(Boolean);
  const lAliases = [normalizeText(locatedAlias)].filter(Boolean);

  if (s === l) {
    factors.push({ factor: MatchFactor.NAME_EXACT, points: W.nameExact });
  } else if (sAliases.includes(l) || lAliases.includes(s)) {
    factors.push({ factor: MatchFactor.NAME_ALIAS, points: W.nameAlias });
  } else {
    const sTokens = new Set(nameTokens(seekingName).concat(sAliases.flatMap(nameTokens)));
    const lTokens = new Set(nameTokens(locatedName).concat(lAliases.flatMap(nameTokens)));
    let best = 0;
    for (const t of sTokens) {
      if (t.length >= 2 && lTokens.has(t)) best = Math.max(best, t.length);
    }
    if (best >= 2) factors.push({ factor: MatchFactor.NAME_PARTIAL, points: W.namePartial });
  }
  return factors;
}

function compareAge(aAge, aBand, bAge, bBand) {
  // 显式年龄相差很小是更强的证据，与年龄段一致不重复计分
  if (Number.isInteger(aAge) && Number.isInteger(bAge) && Math.abs(aAge - bAge) <= 2) {
    return [{ factor: MatchFactor.AGE_CLOSE, points: W.ageClose }];
  }
  const bandA = aBand ?? ageBandFor(aAge);
  const bandB = bBand ?? ageBandFor(bAge);
  if (bandA && bandB && bandA === bandB) {
    return [{ factor: MatchFactor.AGE_BAND, points: W.ageBand }];
  }
  return [];
}

function comparePlaces(a, b) {
  const pa = normalizeText(a);
  const pb = normalizeText(b);
  if (!pa || !pb) return [];
  if (pa === pb) return [{ factor: MatchFactor.PLACE_EXACT, points: W.placeExact }];
  if (pa.includes(pb) || pb.includes(pa)) {
    return [{ factor: MatchFactor.PLACE_PARTIAL, points: W.placePartial }];
  }
  return [];
}

function compareClues(aClues, bClues) {
  const hits = [];
  for (const ca of aClues) {
    const va = normalizeText(ca?.value);
    if (!va) continue;
    for (const cb of bClues) {
      if (cb?.type !== ca?.type) continue;
      if (normalizeText(cb?.value) === va) {
        hits.push(ca.type);
        break;
      }
    }
  }
  if (!hits.length) return [];
  const points = Math.min(hits.length * W.sharedClueEach, W.sharedClueCap);
  return [{ factor: MatchFactor.SHARED_CLUE, points, matchedTypes: hits }];
}

export function scorePair(seeking, located) {
  const factors = [
    ...compareNames(seeking.person_name, seeking.alias_name, located.person_name, located.alias_name),
    ...compareAge(seeking.est_age, seeking.age_band, located.est_age, located.age_band),
  ];
  if (normalizeText(seeking.gender) && normalizeText(seeking.gender) === normalizeText(located.gender)) {
    factors.push({ factor: MatchFactor.GENDER, points: W.gender });
  }
  factors.push(...comparePlaces(seeking.last_contact_place, located.last_contact_place));
  factors.push(...compareClues(seeking.clues || [], located.clues || []));

  const score = factors.reduce((sum, f) => sum + f.points, 0);
  let confidence = null;
  if (score >= T.high) confidence = Confidence.HIGH;
  else if (score >= T.medium) confidence = Confidence.MEDIUM;
  else if (score >= T.candidateMin) confidence = Confidence.LOW;
  return { score, confidence, factors };
}

// 是否“仅凭姓名”——无任何姓名之外的支撑证据。用于展示提示。
export function isNameOnly(factors) {
  return factors.length > 0 && factors.every((f) => f.factor.startsWith("name"));
}

// 强佐证：接触地点、共有身份线索或别名。年龄/性别等人口学属性为弱佐证，
// 同名 + 弱属性仍不足以安排见面（同名同龄同性别者并不唯一）。
const STRONG_FACTORS = new Set([
  MatchFactor.PLACE_EXACT,
  MatchFactor.PLACE_PARTIAL,
  MatchFactor.SHARED_CLUE,
  MatchFactor.NAME_ALIAS,
]);

export function hasStrongCorroboration(factors) {
  return factors.some((f) => STRONG_FACTORS.has(f.factor));
}
