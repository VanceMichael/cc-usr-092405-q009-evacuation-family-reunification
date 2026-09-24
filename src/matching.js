// 疑似同一人候选匹配：只产出带置信依据的候选，绝不自动合并。
// 设计原则：仅比对登记时保存的最少身份线索；同名只是依据之一，
// 必须有额外线索支撑才可能达到 high；依据可向审计员重建。

import { normalizeText, coarsePlace } from "./util.js";

export const Confidence = Object.freeze({ HIGH: "high", MEDIUM: "medium", LOW: "low" });

const NAME_EXACT = 45;
const AGE_BAND = 10;
const AGE_CLOSE = 10;
const MARK_SHARED = 25;
const PLACE_COARSE = 20;
const PLACE_DETAIL = 10;
const TIME_CLOSE = 10;

/**
 * @param {object} a 登记线索
 * @param {object} b 登记线索
 * @returns {{score:number, confidence:string, basis:Array} | null}
 */
export function scoreCandidate(a, b) {
  a = { name: a.person_name, ...a };
  b = { name: b.person_name, ...b };
  const basis = [];
  let score = 0;

  const nameA = normalizeText(a.name);
  const nameB = normalizeText(b.name);
  if (!nameA || !nameB) return null; // 无姓名线索不自动配对
  if (nameA === nameB) {
    score += NAME_EXACT;
    basis.push({ clue: "name", weight: NAME_EXACT, reason: "normalized_name_equal" });
  } else {
    return null; // 姓名不同不形成候选（同名是进入候选的必要条件）
  }

  // 年龄段
  const bandA = a.age_band ?? "unknown";
  const bandB = b.age_band ?? "unknown";
  if (bandA !== "unknown" && bandA === bandB) {
    score += AGE_BAND;
    basis.push({ clue: "age_band", weight: AGE_BAND, reason: "age_band_equal" });
  }

  // 近似年龄
  const ageA = Number(a.approx_age);
  const ageB = Number(b.approx_age);
  if (Number.isFinite(ageA) && Number.isFinite(ageB)) {
    const diff = Math.abs(ageA - ageB);
    const tolerance = bandA === "child" ? 1 : 2; // 儿童年龄容差更严
    if (diff <= tolerance) {
      score += AGE_CLOSE;
      basis.push({ clue: "approx_age", weight: AGE_CLOSE, reason: `age_within_${tolerance}` });
    }
  }

  // 体貌特征（交集，按词归一化）
  const marksA = new Set((a.distinguishing_marks ?? []).map(normalizeText).filter(Boolean));
  const marksB = new Set((b.distinguishing_marks ?? []).map(normalizeText).filter(Boolean));
  const sharedMarks = [...marksA].filter((m) => marksB.has(m));
  if (sharedMarks.length > 0) {
    score += MARK_SHARED;
    basis.push({ clue: "distinguishing_marks", weight: MARK_SHARED, reason: "shared_mark", value: sharedMarks });
  }

  // 最后接触地点
  const placeA = normalizeText(a.last_contact_place);
  const placeB = normalizeText(b.last_contact_place);
  if (placeA && placeA === placeB) {
    score += PLACE_DETAIL;
    basis.push({ clue: "last_contact_place", weight: PLACE_DETAIL, reason: "place_equal" });
  } else if (coarsePlace(placeA) && coarsePlace(placeA) === coarsePlace(placeB)) {
    score += PLACE_COARSE;
    basis.push({ clue: "last_contact_place", weight: PLACE_COARSE, reason: "coarse_place_equal" });
  }

  // 最后接触时间（48 小时内）
  const tA = Date.parse(a.last_contact_at ?? "");
  const tB = Date.parse(b.last_contact_at ?? "");
  if (!Number.isNaN(tA) && !Number.isNaN(tB) && Math.abs(tA - tB) <= 48 * 3600 * 1000) {
    score += TIME_CLOSE;
    basis.push({ clue: "last_contact_at", weight: TIME_CLOSE, reason: "within_48h" });
  }

  // 同名之外必须至少一条独立线索
  const independent = basis.filter((x) => x.clue !== "name");
  if (independent.length === 0) return null;

  const confidence =
    score >= 70 ? Confidence.HIGH : score >= 50 ? Confidence.MEDIUM : Confidence.LOW;

  return { score, confidence, basis };
}
