// 脱敏视图：工作人员只看到自己一侧的完整线索，对侧仅保留匹配所必需的粗粒度信息。
import { maskName, maskPhone, coarsePlace } from "./util.js";

function maskMarks(marks) {
  return (marks ?? []).map((m) => maskName(m));
}

function dayOnly(iso) {
  return iso ? iso.slice(0, 10) : null;
}

/** 对侧登记的脱敏形态 */
export function maskCounterparty(reg) {
  return {
    id: reg.id,
    report_kind: reg.report_kind,
    person_name_masked: maskName(reg.person_name),
    age_band: reg.age_band,
    relationship: reg.relationship, // 关系类别本身是枚举，不是自由文本
    relationship_detail: reg.relationship === "neighbor" ? "邻居临时代看" : null,
    reporter_name_masked: maskName(reg.reporter_name),
    contact_phone_masked: maskPhone(reg.contact_phone),
    last_contact_place_coarse: coarsePlace(reg.last_contact_place),
    last_contact_date: dayOnly(reg.last_contact_at),
    distinguishing_marks_masked: maskMarks(reg.distinguishing_marks),
    subject_site_id: reg.subject_site_id,
    flags_count: reg.flags.length, // 不向对方披露标记内容；路由原因仅专门人员可见
  };
}

/** 本侧登记：联络员自己录入的数据，可回看 */
export function ownRegistration(reg) {
  return {
    id: reg.id,
    report_kind: reg.report_kind,
    person_name: reg.person_name,
    approx_age: reg.approx_age,
    age_band: reg.age_band,
    distinguishing_marks: reg.distinguishing_marks,
    relationship: reg.relationship,
    relationship_detail: reg.relationship_detail,
    reporter_name: reg.reporter_name,
    contact_phone: reg.contact_phone,
    contact_windows: reg.contact_windows,
    last_contact_place: reg.last_contact_place,
    last_contact_at: reg.last_contact_at,
    flags: reg.flags,
    subject_status: reg.subject_status,
    subject_site_id: reg.subject_site_id,
    registering_site_id: reg.registering_site_id,
  };
}

/** 公开版置信依据：保留线索类别、权重与原因，去掉明文值 */
export function publicBasis(basis) {
  return basis.map((b) => {
    if (b.clue === "distinguishing_marks") {
      return { clue: b.clue, weight: b.weight, reason: b.reason, matched_count: (b.value ?? []).length };
    }
    if (b.clue === "name") {
      return { clue: b.clue, weight: b.weight, reason: b.reason }; // 不回显姓名
    }
    return { clue: b.clue, weight: b.weight, reason: b.reason };
  });
}

export function candidateView({ candidate, regA, regB, siteNameA, siteNameB, viewerSide }) {
  const view = {
    id: candidate.id,
    score: candidate.score,
    confidence: candidate.confidence,
    status: candidate.status,
    active_arrangement_id: candidate.active_arrangement_id ?? null,
    basis: publicBasis(candidate.basis),
    created_at: candidate.created_at,
    sides: {
      a: {
        site_id: regA.registering_site_id,
        site_name: siteNameA,
        is_viewer: viewerSide === "a",
        registration:
          viewerSide === "a" ? ownRegistration(regA) : maskCounterparty(regA),
      },
      b: {
        site_id: regB.registering_site_id,
        site_name: siteNameB,
        is_viewer: viewerSide === "b",
        registration:
          viewerSide === "b" ? ownRegistration(regB) : maskCounterparty(regB),
      },
    },
  };
  if (viewerSide === null) {
    // 专门人员：两侧均脱敏，身份明文走单独的复核接口
    view.sides.a.registration = maskCounterparty(regA);
    view.sides.b.registration = maskCounterparty(regB);
  }
  return view;
}
