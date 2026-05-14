// Fast lexical screen before retrieval — avoids RAG latency on crisis content.
// Deterministic handoff only; clinical decisions remain with trained humans.

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

export function containsMandatoryHandoffSignals(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return DISTRESS_PATTERNS.some((re) => re.test(t));
}

export const MANDATORY_HANDOFF_RESPONSE_HE =
  "זוהתה פנייה רגישה שדורשת מענה אנושי מיידי. " +
  "אנא פנו עכשיו למבוגר אחראי בארגון, לקו חירום רלוונטי, או לשירותי בריאות הנפש (למשל קו ער\"ן 1201 לילדים ונוער / קו חירום 101). " +
  "הבוט אינו מספק ייעוץ בזמן אמת במצבי סיכון.";
