// Fast lexical screens before retrieval. Deterministic handoff and privacy
// guardrails keep the bot in its educational, non-identifying scope.

const DISTRESS_PATTERNS: RegExp[] = [
  /\bkill\s+myself\b/i,
  /\bsuicid\w*\b/i,
  /\bself[-\s]?harm\b/i,
  /\bcut\s+myself\b/i,
  /אובדן\s*עצמי/,
  /לסיים\s*את\s*החיים/,
  /לא\s*רוצה\s*לחיות/,
  /רוצה\s*למות/,
  /להתאבד/,
  /התאבדות/,
  /לפגוע\s*בעצמי/,
  /פגיעה\s*עצמית/,
  /התעללות\s*מינית/,
  /ניצול\s*מיני/,
  /אנסו\s*אותי/,
  /פוגעים\s*בי\s*בבית/,
  /מכים\s*אותי/,
];

const IDENTITY_REQUEST_PATTERNS: RegExp[] = [
  /(?:^|\s)מי(?:\s|$)/i,
  /איזה\s+(?:ילד|תלמיד|ילדה|תלמידה)/i,
  /איזו\s+(?:ילדה|תלמידה)/i,
  /שם\s+של/i,
  /שמות\s+של/i,
  /תן\s+לי\s+שם/i,
  /לזהות\s+(?:ילד|תלמיד|ילדה|תלמידה)/i,
  /מי\s+הילד/i,
  /\bwho\b/i,
  /\bwhich\s+(?:kid|child|student)\b/i,
  /\bname\s+of\b/i,
  /\bidentify\s+(?:a|the)?\s*(?:kid|child|student)\b/i,
];

const PERSONAL_DATA_PATTERNS: RegExp[] = [
  /היסטוריה\s+של/i,
  /נתונים\s+על/i,
  /פרטים\s+על/i,
  /רשימת\s+(?:תלמידים|ילדים|שמות)/i,
  /מעקב\s+אחרי/i,
  /דירוג\s+(?:תלמידים|ילדים)/i,
  /מעמד\s+חברתי/i,
  /\b(?:history|data|profile|records?)\s+(?:of|about)\b/i,
  /\brank\s+(?:kids|children|students)\b/i,
  /\bsocial\s+status\b/i,
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
  /נידוי/i,
  /\bweak\b/i,
  /\bweird\b/i,
  /\bproblematic\b/i,
  /\bbull(?:y|ied|ying)\b/i,
  /\boutcast\b/i,
];

const LOCALIZED_INCIDENT_PATTERNS: RegExp[] = [
  /בכיתה\s+[א-תa-z0-9'"״׳-]+/i,
  /בשכבה\s+[א-תa-z0-9'"״׳-]+/i,
  /בבית\s+הספר/i,
  /בהפסקה/i,
  /אתמול/i,
  /היום/i,
  /השבוע/i,
  /\b(class|grade)\s+[a-z0-9-]+\b/i,
  /\byesterday\b/i,
  /\btoday\b/i,
  /\brecess\b/i,
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
  /סביבה\s+בטוחה/i,
  /\bactivity\b/i,
  /\bworkshop\b/i,
  /\blesson\b/i,
  /\bexplain\b/i,
  /\bempathy\b/i,
  /\bprevention\b/i,
];

export type IntentCategory = "VALID_EDUCATIONAL" | "BORDERLINE" | "PROBLEMATIC";

const AMBIGUOUS_REFERENCE_PATTERNS: RegExp[] = [
  /המקרה\s+הזה/i,
  /הילד\s+הזה/i,
  /התלמיד\s+הזה/i,
  /מה\s+לעשות\s+איתו/i,
  /מה\s+לעשות\s+איתה/i,
  /\bthis\s+(?:case|kid|child|student)\b/i,
  /\bwhat\s+should\s+i\s+do\s+with\s+(?:him|her|them)\b/i,
];

export const PRIVACY_BLOCK_RESPONSE_HE =
  "אני לא יכול לזהות תלמידים או לדבר עליהם באופן אישי. אפשר ללמוד באופן כללי איך לזהות בדידות חברתית, למנוע חרמות, ולבנות פעילות אמפתית ובטוחה בכיתה.";

export const PRIVACY_CLARIFICATION_RESPONSE_HE =
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

export interface SafetyCheckResult {
  /** True when the message matches a life-threatening / severe distress pattern. */
  isEmergency: boolean;
  /** Hardcoded handoff response to return immediately; present only when isEmergency=true. */
  response?: string;
}

/**
 * Hard-fail guard that must be evaluated BEFORE the intent router and RAG pipeline.
 * When isEmergency is true, callers MUST short-circuit the entire flow and return
 * the provided response verbatim — the LLM must never handle these situations.
 */
export function checkSafetySignals(text: string): SafetyCheckResult {
  if (containsMandatoryHandoffSignals(text)) {
    return { isEmergency: true, response: MANDATORY_HANDOFF_RESPONSE_HE };
  }
  return { isEmergency: false };
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

