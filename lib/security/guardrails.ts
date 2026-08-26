// Inbound safety pipeline: PII redaction, then fast lexical screens before
// retrieval. Deterministic handoff and privacy guardrails keep the bot in its
// educational, non-identifying scope.
//
// The two halves run in order: callers redact first with `redactPii`, then pass
// the redacted text to `evaluateInboundSafety` at the bottom of this file. That
// entry point is called from lib/domain/whatsapp/core/incomingMessageProcessor.ts
// BEFORE any database write, LLM call, or trace — nothing else may run first.

import { shouldSkipPrivacyGuardrails, type UserContext } from "@/lib/security/auth";

// ---------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------

// Best-effort PII masking before chunks are embedded or stored.
// Not a substitute for legal review — reduces accidental retention of raw identifiers.

const PHONE_IL = /(?:\+?972|0)(?:-?\d){8,9}\b/g;
const PHONE_GENERIC = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

// Common Israeli school / org phrasing (very coarse — catches literal labels only).
const SCHOOL_LINE = /(?:^|\n)\s*(?:בית\s*ספר|תיכון|חטיבת?\s*ביניים|ישיבה)\s*[:\-]?\s*[^\n]{2,80}/gim;

export function redactPii(text: string): string {
  if (!text.trim()) return text;

  let out = text;
  out = out.replace(PHONE_IL, "[PHONE_REDACTED]");
  out = out.replace(PHONE_GENERIC, "[PHONE_REDACTED]");
  out = out.replace(EMAIL, "[EMAIL_REDACTED]");
  out = out.replace(SCHOOL_LINE, "[ORG_REDACTED]");

  // Mask sequences that look like Israeli national IDs (9 digits with optional dash).
  out = out.replace(/\b\d{1,3}-?\d{4}-?\d{4}\b/g, "[ID_REDACTED]");

  return out;
}

// ---------------------------------------------------------------------------
// Safety signals
// ---------------------------------------------------------------------------

export type IntentCategory = "VALID_EDUCATIONAL" | "BORDERLINE" | "PROBLEMATIC";

const DISTRESS_PATTERNS: RegExp[] = [
  // אובדנות ופגיעה עצמית
  /אובדן\s*עצמי/,
  /לסיים\s*את\s*החיים/,
  /לא\s*רוצה\s*לחיות/,
  /רוצה\s*למות/,
  /להתאבד/,
  /התאבדות/,
  /לפגוע\s*בעצמי/,
  /פגיעה\s*עצמית/,
  /לחתוך\s*את\s*עצמי/,

  // פגיעות מיניות
  /אונס/,
  /נאנס(?:ה|ו|תי)?/,
  /אנסו\s*אות(?:י|ו|ה)/,
  /התעללות\s*מינית/,
  /תקיפה\s*מינית/,
  /הטרדה\s*מינית/,
  /מעשה\s*מגונה/,
  /ניצול\s*מיני/,

  // אלימות פיזית, נשק וסכנת חיים
  /רצח/,
  /לרצוח/,
  /ירצחו/,
  /מכות/,
  /הולכים\s*מכות/,
  /הרביצו/,
  /מרביצים/,
  /מכים\s*אותי/,
  /דם/,
  /שותת\s*דם/,
  /פציעה\s*קשה/,
  /סכין/,
  /דקירה/,
  /דקרו/,
  /לדקור/,
  /אקדח/,
  /נשק/,
  /הצתה/,
  /שריפה/,
  /הורעל/,
  /הרעלה/,

  // פגיעה רגשית חמורה, חרם והשפלה
  /חרם/,
  /עושים\s*חרם/,
  /השפלה/,
  /משפילים/,
  /התעללות/,
  /מתעללים/,
  /סחיטה/,
  /סוחטים/,
  /איומים/,
  /מאיימים\s*על/,
  /פוגעים\s*בי\s*בבית/
];

const IDENTITY_REQUEST_PATTERNS: RegExp[] = [
  /(?:^|\s)מי(?:\s|$)/i,
  /איזה\s+(?:ילד|תלמיד|ילדה|תלמידה)/i,
  /איזו\s+(?:ילדה|תלמידה)/i,
  /שם\s+של/i,
  /שמות\s+של/i,
  /תן\s+לי\s+שם/i,
  /לזהות\s+(?:ילד|תלמיד|ילדה|תלמידה)/i,
  /מי\s+הילד/i
];

const PERSONAL_DATA_PATTERNS: RegExp[] = [
  /היסטוריה\s+של/i,
  /נתונים\s+על/i,
  /פרטים\s+על/i,
  /רשימת\s+(?:תלמידים|ילדים|שמות)/i,
  /מעקב\s+אחרי/i,
  /דירוג\s+(?:תלמידים|ילדים)/i,
  /מעמד\s+חברתי/i
];

const NEGATIVE_TARGETING_PATTERNS: RegExp[] = [
  /חלש/i,
  /מוזר/i,
  /בעייתי/i,
  /מופרע/i,
  /דחוי/i,
  /בודד/i,
  /לא\s+משתלב/i,
  /מציקים\s+לו/i,
  /מציקים\s+לה/i,
  /חרם/i,
  /בריונות/i,
  /נידוי/i
];

const LOCALIZED_INCIDENT_PATTERNS: RegExp[] = [
  /בכיתה\s+[א-ת0-9'"״׳-]+/i,
  /בשכבה\s+[א-ת0-9'"״׳-]+/i,
  /בבית\s+הספר/i,
  /בהפסקה/i,
  /אתמול/i,
  /היום/i,
  /השבוע/i
];

const EDUCATIONAL_SCOPE_PATTERNS: RegExp[] = [
  /פעילות/i,
  /סדנה/i,
  /מערך/i,
  /שיעור/i,
  /הסבר/i,
  /אמפתיה/i,
  /מניעת/i,
  /שיח\s+חברתי/i,
  /סביבה\s+בטוחה/i
];

const AMBIGUOUS_REFERENCE_PATTERNS: RegExp[] = [
  /המקרה\s+הזה/i,
  /הילד\s+הזה/i,
  /התלמיד\s+הזה/i,
  /מה\s+לעשות\s+איתו/i,
  /מה\s+לעשות\s+איתה/i
];

export const PRIVACY_BLOCK_RESPONSE_HE =
  "אני לא יכול לזהות תלמידים או לדבר עליהם באופן אישי. אפשר ללמוד באופן כללי איך לזהות בדידות חברתית, למנוע חרמות, ולבנות פעילות אמפתית ובטוחה בכיתה.";

const PRIVACY_CLARIFICATION_RESPONSE_HE =
  "האם אתה מתכוון למקרה כללי או למצב מסוים בכיתה? כדי לשמור על פרטיות, אל תכתוב שמות או פרטים מזהים.";

export interface SafetySignals {
  safetyRiskScore: number;
  intentCategory: IntentCategory;
  rewrittenQuery: string | null;
  finalResponse?: string;
}

export function containsMandatoryHandoffSignals(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return DISTRESS_PATTERNS.some((re) => re.test(t));
}

export const MANDATORY_HANDOFF_RESPONSE_HE =
  "זוהתה פנייה רגישה שדורשת מענה אנושי מיידי. " +
  'אנא פנו עכשיו למבוגר אחראי בארגון, ליועצת בית הספר, או לקווי חירום (ער"ן 1201 / משטרה 100 / מד"א 101). ' +
  "הבוט אינו מספק ייעוץ בזמן אמת במצבי סיכון.";

function hasAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function buildSafeRewrite(text: string): string | null {
  if (!text.trim()) return null;

  if (hasAny(NEGATIVE_TARGETING_PATTERNS, text) || hasAny(IDENTITY_REQUEST_PATTERNS, text)) {
    return "איך מזהים מצבים של בדידות חברתית, חרם או פגיעה חברתית בכיתה, ואיך אפשר לעזור באופן כללי בלי לזהות תלמידים?";
  }

  if (hasAny(LOCALIZED_INCIDENT_PATTERNS, text)) {
    return "איך מנתחים מצב חברתי בכיתה באופן כללי ובונים פעילות חינוכית שמקדמת אמפתיה וסביבה בטוחה?";
  }

  return null;
}

export function classifySafetySignals(text: string): SafetySignals {
  const trimmed = text.trim();

  if (!trimmed) {
    return {
      safetyRiskScore: 0,
      intentCategory: "VALID_EDUCATIONAL",
      rewrittenQuery: null,
    };
  }

  if (containsMandatoryHandoffSignals(trimmed)) {
    return {
      safetyRiskScore: 100,
      intentCategory: "PROBLEMATIC",
      rewrittenQuery: null,
      finalResponse: MANDATORY_HANDOFF_RESPONSE_HE,
    };
  }

  const identityRequest = hasAny(IDENTITY_REQUEST_PATTERNS, trimmed);
  const personalDataRequest = hasAny(PERSONAL_DATA_PATTERNS, trimmed);
  const negativeTargeting = hasAny(NEGATIVE_TARGETING_PATTERNS, trimmed);
  const localizedIncident = hasAny(LOCALIZED_INCIDENT_PATTERNS, trimmed);
  const educationalScope = hasAny(EDUCATIONAL_SCOPE_PATTERNS, trimmed);
  const ambiguousReference = hasAny(AMBIGUOUS_REFERENCE_PATTERNS, trimmed);

  let safetyRiskScore = 0;
  if (identityRequest) safetyRiskScore += 45;
  if (personalDataRequest) safetyRiskScore += 55;
  if (negativeTargeting) safetyRiskScore += 25;
  if (localizedIncident) safetyRiskScore += 20;
  if (ambiguousReference) safetyRiskScore += 15;
  if (educationalScope) safetyRiskScore = Math.max(0, safetyRiskScore - 10);
  safetyRiskScore = Math.min(100, safetyRiskScore);

  const hardPrivacyBlock =
    personalDataRequest || safetyRiskScore >= 85 || (identityRequest && localizedIncident);

  if (hardPrivacyBlock) {
    return {
      safetyRiskScore,
      intentCategory: "PROBLEMATIC",
      rewrittenQuery: buildSafeRewrite(trimmed),
      finalResponse: PRIVACY_BLOCK_RESPONSE_HE,
    };
  }

  if (ambiguousReference && !educationalScope && !identityRequest) {
    return {
      safetyRiskScore: Math.max(safetyRiskScore, 40),
      intentCategory: "BORDERLINE",
      rewrittenQuery: null,
      finalResponse: PRIVACY_CLARIFICATION_RESPONSE_HE,
    };
  }

  if (identityRequest) {
    return {
      safetyRiskScore: Math.max(safetyRiskScore, 65),
      intentCategory: "PROBLEMATIC",
      rewrittenQuery: buildSafeRewrite(trimmed),
    };
  }

  if (negativeTargeting || localizedIncident) {
    return {
      safetyRiskScore: Math.max(safetyRiskScore, 40),
      intentCategory: "BORDERLINE",
      rewrittenQuery: buildSafeRewrite(trimmed),
    };
  }

  return {
    safetyRiskScore,
    intentCategory: "VALID_EDUCATIONAL",
    rewrittenQuery: null,
  };
}

export type InboundSafetyDecision =
  /** Life-safety. Reply verbatim and stop — no retrieval, no LLM, no exceptions. */
  | { action: "handoff"; response: string; signals: SafetySignals }
  /** Privacy violation. Reply verbatim and stop. Non-elevated tiers only. */
  | { action: "block"; response: string; signals: SafetySignals }
  /**
   * Continue. `query` is what retrieval and the LLM must use — it is either the
   * original redacted text or a de-identified rewrite, never the raw input.
   */
  | { action: "proceed"; query: string; signals: SafetySignals };

/**
 * The single safety gate for inbound traffic.
 *
 * Ordering is the whole point of this function, so it is spelled out:
 *
 *   1. Distress is evaluated FIRST and for EVERY tier (L0–L3). No role, flag,
 *      or config can skip it. A crisis message must never reach an LLM.
 *   2. Only then does the privilege check apply, and only to privacy rules.
 *   3. Otherwise a safe rewrite may replace the query for retrieval purposes.
 *
 * @param redactedText Output of `redactPii`. Callers must never pass raw input —
 *   whatever is handed in here is what ends up in logs and traces downstream.
 */
export function evaluateInboundSafety(
  redactedText: string,
  user: UserContext
): InboundSafetyDecision {
  const signals = classifySafetySignals(redactedText);

  // (1) Un-skippable. Checked against the pattern list directly rather than via
  // the score so no future scoring tweak can accidentally lower this below a
  // threshold and disable the handoff.
  if (containsMandatoryHandoffSignals(redactedText)) {
    return {
      action: "handoff",
      response: signals.finalResponse ?? MANDATORY_HANDOFF_RESPONSE_HE,
      signals,
    };
  }

  // (2) Privilege applies to privacy rules only.
  if (shouldSkipPrivacyGuardrails(user)) {
    return { action: "proceed", query: redactedText, signals };
  }

  if (signals.finalResponse) {
    return { action: "block", response: signals.finalResponse, signals };
  }

  // (3) A rewrite strips identifying framing while keeping the pedagogical
  // intent, so the mentor still gets a useful answer instead of a refusal.
  return { action: "proceed", query: signals.rewrittenQuery ?? redactedText, signals };
}

