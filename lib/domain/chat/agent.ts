// Baseline chat agent: the lexical intent gate and the handlers each intent
// dispatches to.
//
// Entry point is `processBaselineQuery` in the Orchestrator section at the
// bottom. Sections are ordered so each only uses the ones above it.
//
// The RAG path lives in lib/domain/chat/rag.ts and is imported here rather than
// merged in. Folding lib/domain/chat/state.ts into this file would have created
// an agent -> rag -> agent cycle, so ChatMessage stays a standalone leaf.

import { CLAUDE_FAST_MODEL, getLlmAdapter } from "@/lib/domain/chat/llm";
import {
  deleteAdminManagedUser,
  getAllManagedUsers,
  getUserByPhone,
  insertAdminManagedUser,
  isAdminRole,
  isElevatedRole,
  isManagerRole,
  normalizePhoneNumber,
  type PermissionLevel,
  type UserContext,
} from "@/lib/security/auth";
import {
  fetchTodayChatHistoryForPhone,
  findUsersByDisplayName,
  formatStaffRowsAsDirectReport,
  loadTodayStaffContext,
} from "@/lib/domain/chat/session/adminHistory";
import {
  enterAdminAnalyticsMode,
  exitAdminAnalyticsMode,
  isInAdminAnalyticsMode,
} from "@/lib/domain/chat/session/adminAnalyticsSession";
import { logError, logInfo, logWarn } from "@/lib/core/logger";
import {
  clearAdminSession,
  getAdminSession,
  isUserManagementSessionMode,
  MAX_INVALID_ATTEMPTS,
  recordInvalidAttempt,
  SESSION_ABANDONED_MESSAGE,
  setAdminSession,
  type AdminSession,
} from "@/lib/domain/chat/session/adminSession";
import { formatWhatsAppMarkdown } from "@/lib/domain/whatsapp/core/formatting";
import { sendWhatsAppInteractiveButtons } from "@/lib/domain/whatsapp/core/messaging";
import type { ChatMessage } from "@/lib/domain/chat/state";
import { runBaselineRagCore, type BaselineRagCoreResult } from "@/lib/domain/chat/rag";
import {
  containsMandatoryHandoffSignals,
  MANDATORY_HANDOFF_RESPONSE_HE,
} from "@/lib/security/guardrails";

// -------------------------------------------------------------------------
// Intent routing
// -------------------------------------------------------------------------
// Lexical intent gate. Deliberately LLM-free: an extra model round-trip purely to
// pick a label added a full network hop to TTFT on every message. RAG_INQUIRY vs
// chit-chat is now resolved inside the single main generation call instead.

export type BaselineIntent = "RAG_INQUIRY" | "CHAT_HISTORY";

const CHAT_HISTORY_HEURISTICS: RegExp[] = [
  /היסטורי(?:ת|ות)?\s*(?:שיחה|צ'אט|צאט|whatsapp)?/i,
  /סיכום\s*(?:של\s*)?(?:היום|היומי|יומי)/i,
  /שיחות\s*(?:היום|של\s*היום)/i,
  /מה\s*(?:כתבו|שאלו|דיברו)\s*(?:היום|המנטורים|הצוות)/i,
  /תן\s*לי\s*(?:סיכום|דוח)\s*(?:שיחות|יומי)/i,
  /chat\s*history/i,
  /daily\s*summary/i,
];

/**
 * Synchronous O(n) lexical probe for chat-history requests.
 * Consumed by the orchestrator's single-pass sweep — never call an LLM for this.
 */
export function matchesChatHistoryHeuristic(query: string): boolean {
  return CHAT_HISTORY_HEURISTICS.some((pattern) => pattern.test(query));
}

const USER_MANAGEMENT_HEURISTICS: RegExp[] = [
  /להוסיף\s+(תלמיד|תלמידה|מנהל|מנהלת|מישהו|מישהי)/i,
  /הוספת\s+(תלמיד|תלמידה|מנהל|מנהלת)/i,
  /למחוק\s+(תלמיד|תלמידה|מנהל|מנהלת|מישהו|מישהי)/i,
  /מחיקת\s+(תלמיד|תלמידה|מנהל|מנהלת)/i,
  /ניהול\s+משתמשים/i,
];

/**
 * Synchronous lexical probe for L0/L1 user-management requests.
 * Consumed by the orchestrator before chat-history / RAG routing.
 */
export function matchesUserManagementHeuristic(query: string): boolean {
  return USER_MANAGEMENT_HEURISTICS.some((pattern) => pattern.test(query));
}

// Deliberately whole-message matches (anchored ^...$): an admin's analytics
// follow-up question might legitimately contain the word "exit"/"יציאה" mid-sentence
// (e.g. "מי יצא מהיסטוריית השיחה?"), so only a bare exit command should short-circuit.
const ANALYTICS_EXIT_HEURISTICS: RegExp[] = [
  /^\s*(cancel|exit|בטל|ביטול|יציאה|צא|חזור)\s*$/i,
];

/**
 * Cheap lexical check for an explicit exit from ADMIN_ANALYTICS_MODE, tried before
 * any LLM classification step so "cancel"/"exit" always resolves deterministically.
 */
export function matchesAdminAnalyticsExitCommand(query: string): boolean {
  return ANALYTICS_EXIT_HEURISTICS.some((pattern) => pattern.test(query.trim()));
}

/** Cheap/fast model tier, used by the L0/L1 chat-history summarisers. */
export function resolveFastModel(): string {
  const provider = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();
  const explicit = process.env.LLM_FAST_MODEL?.trim();
  if (explicit) return explicit;

  switch (provider) {
    case "openai":
      return "gpt-4o-mini";
    case "gemini":
      return process.env.GEMINI_FAST_MODEL ?? "gemini-3.5-flash";
    case "claude":
      return CLAUDE_FAST_MODEL;
    default:
      return "mock-fast";
  }
}

// -------------------------------------------------------------------------
// Admin analytics handler
// -------------------------------------------------------------------------

const EXIT_CONFIRMATION_HE = "יצאת ממצב ניתוח דוחות. אפשר לבקש דוח חדש בכל שלב.";

const CLASSIFIER_PROMPT =
  'אתה מסווג הודעות. המנהל (L0) נמצא כרגע במצב ניתוח דוחות שיחות צוות, לאחר שקיבל ' +
  "דוח היסטוריית שיחות. קבע אם ההודעה הבאה היא שאלת המשך הקשורה לנתוני השיחות/דוחות/" +
  'משתמשים שהתקבלו, לעומת נושא לא קשור כלל (למשל תמיכה טכנית אישית, איפוס סיסמה וכו). ' +
  'החזר JSON תקני בלבד בפורמט: {"isAnalytical": true} או {"isAnalytical": false}, ללא טקסט נוסף.';

/**
 * LLM-based ambiguity check: is this free-text message actually a follow-up about
 * the report, or a completely unrelated question that should fall back to RAG?
 * Kept out of the lexical intentRouter.ts on purpose - this needs real judgment
 * that regex heuristics can't provide (see file header comment there re: LLM-free
 * routing for the *hot* path; this only runs for the narrow ADMIN_ANALYTICS_MODE case).
 */
async function isAnalyticalQuery(query: string, signal?: AbortSignal | null): Promise<boolean> {
  try {
    const raw = await getLlmAdapter().generateText({
      model: resolveFastModel(),
      temperature: 0,
      signal,
      messages: [
        { role: "system", content: CLASSIFIER_PROMPT },
        { role: "user", content: query },
      ],
      responseSchema: {
        type: "object",
        properties: { isAnalytical: { type: "boolean" } },
        required: ["isAnalytical"],
      },
    });
    const jsonText = raw.trim().match(/\{[\s\S]*\}/)?.[0] ?? raw;
    const parsed = JSON.parse(jsonText) as { isAnalytical?: unknown };
    return Boolean(parsed.isAnalytical);
  } catch (err) {
    // Fail open toward the safe, DB-grounded analytics handler rather than silently
    // reverting to RAG document search on a transient LLM/parse failure - that
    // reversion is exactly the bug this handler exists to fix.
    logWarn("admin_analytics_classifier_failed", "Defaulting isAnalytical=true", {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

const ANALYTICS_QA_PROMPT =
  "אתה עוזר למנהל (L0) לנתח את נתוני היום שהתקבלו מהיסטוריית השיחות. ענה בעברית, " +
  "קצר וממוקד, אך ורק על סמך הנתונים שסופקו למטה. אם המידע הנתון לא מספיק לענות " +
  "על השאלה, אמור זאת במפורש במקום להמציא תשובה.";

/** Answers a free-text follow-up using the day's chat-history rows as grounding -
 * this is the "dedicated conversational analytics handler that utilizes the
 * database" the router falls into instead of RAG. */
async function answerFromChatHistory(
  query: string,
  requesterPermissionLevel: PermissionLevel,
  signal?: AbortSignal | null
): Promise<string> {
  const { formatted } = await loadTodayStaffContext(requesterPermissionLevel);

  const answer = await getLlmAdapter().generateText({
    model: resolveFastModel(),
    temperature: 0.2,
    signal,
    messages: [
      { role: "system", content: ANALYTICS_QA_PROMPT },
      { role: "user", content: `נתוני היום:\n${formatted}\n\nשאלת המנהל: ${query}` },
    ],
  });
  return answer.trim();
}

export type AdminAnalyticsFollowUpResult =
  | { handled: true; answer: string }
  | { handled: false };

/**
 * Entry point consulted by the orchestrator before the lexical sweep / RAG
 * fallback. Only ever returns `handled: true` for genuine L0 follow-up questions
 * about a just-generated report; everything else (wrong role, not in the mode, an
 * explicit exit, or an off-topic question per the LLM check) returns
 * `handled: false` so the caller's existing routing runs unchanged.
 */
export async function resolveAdminAnalyticsFollowUp(input: {
  adminPhone: string;
  query: string;
  requesterPermissionLevel: PermissionLevel;
  signal?: AbortSignal | null;
}): Promise<AdminAnalyticsFollowUpResult> {
  // Security: only L0 admins can ever enter/consult ADMIN_ANALYTICS_MODE. This
  // mirrors the guard in resolveL0AdminFlow - requesterPermissionLevel is always
  // DB-resolved, never taken from the message payload.
  if (!isAdminRole(input.requesterPermissionLevel)) {
    return { handled: false };
  }

  const inMode = await isInAdminAnalyticsMode(input.adminPhone);
  if (!inMode) {
    return { handled: false };
  }

  if (matchesAdminAnalyticsExitCommand(input.query)) {
    await exitAdminAnalyticsMode(input.adminPhone);
    return { handled: true, answer: EXIT_CONFIRMATION_HE };
  }

  const analytical = await isAnalyticalQuery(input.query, input.signal);
  if (!analytical) {
    // Ambiguous/unrelated query: gracefully exit the mode and let the orchestrator's
    // normal RAG path answer it, instead of forcing an analytics answer.
    await exitAdminAnalyticsMode(input.adminPhone);
    return { handled: false };
  }

  const answer = await answerFromChatHistory(
    input.query,
    input.requesterPermissionLevel,
    input.signal
  );
  return { handled: true, answer };
}

// -------------------------------------------------------------------------
// Chat history handlers
// -------------------------------------------------------------------------

const L0_BUTTON_DAILY = "l0_daily_summary";
const L0_BUTTON_SPECIFIC = "l0_specific_user";

const STAFF_ONLY_SUMMARY_PROMPT =
  "סכם את אינטראקציות היום עם משתמשי L2 ו-L3 במשפט אחד בלבד — פסקה אחת קצרה בעברית, ללא רשימות.";
const FULL_SCOPE_SUMMARY_PROMPT =
  "סכם את אינטראקציות היום עם כל המשתמשים (L0 עד L3) במשפט אחד בלבד — פסקה אחת קצרה בעברית, ללא רשימות.";

const L0_SPECIFIC_USER_PROMPT =
  "הקלד/י את שם המשתמש (כפי שמופיע במערכת) כדי לקבל את היסטוריית השיחה שלו להיום.";
const L0_MENU_RETRY_MESSAGE =
  "בחירה לא מזוהה. הקלד/י 1 לסיכום יומי, 2 למשתמש ספציפי, או ביטול ליציאה.";
const L0_MENU_CANCELLED_MESSAGE = "הפעולה בוטלה.";
const L0_UNKNOWN_BUTTON_MESSAGE = "בחירה לא מזוהה. שלח שוב בקשה להיסטוריית שיחות.";

export type L0MenuChoice = "daily" | "specific" | "cancel";

/**
 * Maps a button tap OR a typed reply ("1", "2", button title) to a menu action.
 * WhatsApp clients that cannot render reply-buttons show a numbered list; users
 * then type the number instead of tapping. That text must not fall through to RAG.
 */
export function parseL0MenuChoice(query: string, buttonId?: string): L0MenuChoice | null {
  if (buttonId === L0_BUTTON_DAILY) return "daily";
  if (buttonId === L0_BUTTON_SPECIFIC) return "specific";

  const text = query.trim();
  if (!text) return null;
  if (matchesAdminAnalyticsExitCommand(text)) return "cancel";

  if (
    /^\s*1[\.)]?\s*$/.test(text) ||
    /^\s*1[\.)]?\s*(?:סיכום\s*יומי|daily\s*summary)\s*$/i.test(text) ||
    /^\s*(?:סיכום\s*יומי|daily\s*summary)\s*$/i.test(text) ||
    text === L0_BUTTON_DAILY
  ) {
    return "daily";
  }

  if (
    /^\s*2[\.)]?\s*$/.test(text) ||
    /^\s*2[\.)]?\s*(?:משתמש\s*ספציפי|specific\s*user)\s*$/i.test(text) ||
    /^\s*(?:משתמש\s*ספציפי|specific\s*user)\s*$/i.test(text) ||
    text === L0_BUTTON_SPECIFIC
  ) {
    return "specific";
  }

  return null;
}

async function summarizeStaffDay(
  rawData: string,
  requesterPermissionLevel: PermissionLevel,
  signal?: AbortSignal | null
): Promise<string> {
  const systemPrompt = isAdminRole(requesterPermissionLevel)
    ? FULL_SCOPE_SUMMARY_PROMPT
    : STAFF_ONLY_SUMMARY_PROMPT;
  const adapter = getLlmAdapter();
  const answer = await adapter.generateText({
    model: resolveFastModel(),
    temperature: 0.2,
    signal,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: rawData },
    ],
  });
  return formatWhatsAppMarkdown(answer);
}

export async function runL1DailyStaffSummary(
  requesterPermissionLevel: PermissionLevel,
  signal?: AbortSignal | null
): Promise<string> {
  // Report scope (L0 → all tiers, everyone else → L2/L3) is resolved inside
  // fetchTodayStaffChatHistories from this trusted, DB-derived level - never from
  // an externally-supplied filter.
  const { formatted } = await loadTodayStaffContext(requesterPermissionLevel);
  return summarizeStaffDay(formatted, requesterPermissionLevel, signal);
}

async function sendL0HistoryMenu(to: string, signal?: AbortSignal | null): Promise<void> {
  await setAdminSession(to, "awaiting_menu_choice");
  await sendWhatsAppInteractiveButtons({
    to,
    bodyText: "בחר סוג דוח היסטוריית שיחות:\n1. סיכום יומי\n2. משתמש ספציפי",
    buttons: [
      { id: L0_BUTTON_DAILY, title: "סיכום יומי" },
      { id: L0_BUTTON_SPECIFIC, title: "משתמש ספציפי" },
    ],
    signal,
  });
}

async function fulfillDailySummary(
  adminPhone: string,
  requesterPermissionLevel: PermissionLevel,
  signal?: AbortSignal | null
): Promise<{ type: "text"; answer: string }> {
  await clearAdminSession(adminPhone);
  const answer = await runL1DailyStaffSummary(requesterPermissionLevel, signal);
  await enterAdminAnalyticsMode(adminPhone);
  return { type: "text", answer };
}

async function fulfillSpecificUserPrompt(
  adminPhone: string
): Promise<{ type: "prompt_sent"; promptText: string }> {
  await setAdminSession(adminPhone, "awaiting_user_name");
  return { type: "prompt_sent", promptText: L0_SPECIFIC_USER_PROMPT };
}

async function handleL0SpecificUserName(
  nameInput: string,
  requesterPermissionLevel: PermissionLevel
): Promise<string> {
  const matches = await findUsersByDisplayName(nameInput, requesterPermissionLevel);
  if (matches.length === 0) {
    return `לא נמצא משתמש בשם "${nameInput}". נסה שם מדויק יותר.`;
  }

  const user = matches[0];
  const label = user.displayName ?? user.phoneNumber;
  const rows = await fetchTodayChatHistoryForPhone(user.phoneNumber, requesterPermissionLevel);
  return formatStaffRowsAsDirectReport(rows, label);
}

export async function resolveL0AdminFlow(input: {
  adminPhone: string;
  query: string;
  buttonId?: string;
  isChatHistoryIntent: boolean;
  requesterPermissionLevel: PermissionLevel;
  signal?: AbortSignal | null;
}): Promise<
  | { type: "text"; answer: string }
  | { type: "interactive_sent" }
  | { type: "prompt_sent"; promptText: string }
> {
  // Defense-in-depth: requesterPermissionLevel is resolved server-side from the DB
  // (lookupUserByPhone) by the orchestrator, never from the WhatsApp payload/button
  // id. This flow grants access to every user's chat history, so if it is ever
  // reached by a non-admin (e.g. a future refactor bug), fail closed and log it
  // rather than trust the caller.
  if (!isAdminRole(input.requesterPermissionLevel)) {
    logError(
      "l0_admin_flow_permission_violation",
      new Error("non-admin reached L0 admin flow"),
      { adminPhone: input.adminPhone, requesterPermissionLevel: input.requesterPermissionLevel }
    );
    return { type: "text", answer: "" };
  }

  const session = await getAdminSession(input.adminPhone);

  if (session && isUserManagementSessionMode(session.mode)) {
    return { type: "text", answer: "" };
  }

  const menuChoice = parseL0MenuChoice(input.query, input.buttonId);
  const inHistoryMenu = session?.mode === "awaiting_menu_choice";

  if (menuChoice === "cancel" && (inHistoryMenu || session?.mode === "awaiting_user_name")) {
    await clearAdminSession(input.adminPhone);
    return { type: "text", answer: L0_MENU_CANCELLED_MESSAGE };
  }

  if (menuChoice === "daily" && (inHistoryMenu || input.buttonId)) {
    logInfo("l0_menu_choice_resolved", "Daily summary selected.", {
      adminPhone: input.adminPhone,
      via: input.buttonId ? "button" : "text",
    });
    return fulfillDailySummary(input.adminPhone, input.requesterPermissionLevel, input.signal);
  }

  if (menuChoice === "specific" && (inHistoryMenu || input.buttonId)) {
    logInfo("l0_menu_choice_resolved", "Specific-user prompt selected.", {
      adminPhone: input.adminPhone,
      via: input.buttonId ? "button" : "text",
    });
    return fulfillSpecificUserPrompt(input.adminPhone);
  }

  if (input.buttonId && !menuChoice) {
    await clearAdminSession(input.adminPhone);
    return { type: "text", answer: L0_UNKNOWN_BUTTON_MESSAGE };
  }

  if (session?.mode === "awaiting_user_name") {
    await clearAdminSession(input.adminPhone);
    const answer = await handleL0SpecificUserName(input.query, input.requesterPermissionLevel);
    await enterAdminAnalyticsMode(input.adminPhone);
    return { type: "text", answer };
  }

  if (inHistoryMenu && session) {
    if (input.isChatHistoryIntent) {
      await sendL0HistoryMenu(input.adminPhone, input.signal);
      return { type: "interactive_sent" };
    }
    if ((await recordInvalidAttempt(input.adminPhone, session)) >= MAX_INVALID_ATTEMPTS) {
      return { type: "text", answer: SESSION_ABANDONED_MESSAGE };
    }
    return { type: "text", answer: L0_MENU_RETRY_MESSAGE };
  }

  if (input.isChatHistoryIntent) {
    await sendL0HistoryMenu(input.adminPhone, input.signal);
    return { type: "interactive_sent" };
  }

  return { type: "text", answer: "" };
}

// -------------------------------------------------------------------------
// User management handlers
// -------------------------------------------------------------------------

export const ADMIN_ACTION_ADD_USER = "admin_action_add_user";
export const ADMIN_ACTION_DELETE_USER = "admin_action_delete_user";
export const ADMIN_ACTION_LIST_USERS = "admin_action_list_users";

export const ADD_USER_PROMPT =
  "אנא כתוב את המשתמש בפורמט הבא:\nשם משתמש, מספר טלפון, רמת הרשאה";
export const DELETE_USER_PROMPT =
  "אנא כתוב את המשתמש בפורמט הבא:\nשם משתמש מספר טלפון";
export const HIERARCHY_DENIED_MESSAGE =
  "אין לך את ההרשאה להוסיף או למחוק רמת הרשאה מעלייך";
export const SELF_DELETE_DENIED_MESSAGE = "אינך יכול למחוק את עצמך";
export const USER_ADDED_MESSAGE = "המשתמש נוסף בהצלחה";
export const USER_DELETED_MESSAGE = "המשתמש הוסר בהצלחה";

export const ADD_FORMAT_RETRY =
  "פורמט לא תקין. אנא נסה שוב לפי הפורמט:\nשם משתמש מספר טלפון רמת הרשאה";
export const ADD_INPUT_EXAMPLE = "ישראל ישראלי, 0541234567, 0";
export const ADD_NOT_ENOUGH_ARGS_MESSAGE =
  `חסרים פרטים. אנא הזן שם, מספר טלפון ורמת הרשאה.\nדוגמה לקלט תקין: ${ADD_INPUT_EXAMPLE}`;
export const ADD_INVALID_LEVEL_MESSAGE =
  `רמת ההרשאה לא זוהתה. יש להזין ספרה בין 0 ל-3.\nדוגמה לקלט תקין: ${ADD_INPUT_EXAMPLE}`;
export const ADD_MISSING_PHONE_MESSAGE =
  `לא זוהה מספר טלפון תקין.\nדוגמה לקלט תקין: ${ADD_INPUT_EXAMPLE}`;
export const ADD_MISSING_NAME_MESSAGE =
  `לא זוהה שם משתמש.\nדוגמה לקלט תקין: ${ADD_INPUT_EXAMPLE}`;
const DELETE_FORMAT_RETRY =
  "פורמט לא תקין. אנא נסה שוב לפי הפורמט:\nשם משתמש מספר טלפון";
const LIST_USERS_DENIED_MESSAGE = "פעולה זו זמינה למנהלי מערכת בלבד";
const USER_EXISTS_MESSAGE = "המשתמש כבר קיים במערכת. נסה מספר טלפון אחר.";
const USER_NOT_FOUND_MESSAGE = "המשתמש לא נמצא במערכת. בדוק את מספר הטלפון ונסה שוב.";
const EMPTY_USER_TABLE_MESSAGE = "לא נמצאו משתמשים במערכת.";
const USER_TABLE_HEADER = "רמת הרשאה | שם משתמש | מספר טלפון";
const UNKNOWN_BUTTON_MESSAGE =
  "בחירה לא מזוהה. שלח 'ניהול משתמשים' כדי לפתוח את התפריט מחדש.";
const USER_MANAGEMENT_MENU_RETRY =
  "בחירה לא מזוהה. הקלד/י 1 להוספה, 2 למחיקה, 3 לטבלת משתמשים, או ביטול ליציאה.";

export const USER_MANAGEMENT_CANCELLED_MESSAGE = "הפעולה בוטלה.";

export type UserManagementMenuChoice = "add" | "delete" | "list" | "cancel";

export type UserManagementFlowResult =
  | { type: "text"; answer: string }
  | { type: "interactive_sent" }
  | { type: "prompt_sent"; promptText: string };

export interface ParsedAddUserInput {
  name: string;
  phone: string;
  level: PermissionLevel;
}

export type ParseAddUserFailureReason =
  | "NOT_ENOUGH_ARGS"
  | "INVALID_LEVEL"
  | "MISSING_PHONE"
  | "MISSING_NAME";

export type ParseAddUserResult =
  | { success: true; data: ParsedAddUserInput }
  | { success: false; reason: ParseAddUserFailureReason };

export interface ParsedDeleteUserInput {
  name: string;
  phone: string;
}

const ADD_PARSE_ERROR_MESSAGES: Record<ParseAddUserFailureReason, string> = {
  NOT_ENOUGH_ARGS: ADD_NOT_ENOUGH_ARGS_MESSAGE,
  INVALID_LEVEL: ADD_INVALID_LEVEL_MESSAGE,
  MISSING_PHONE: ADD_MISSING_PHONE_MESSAGE,
  MISSING_NAME: ADD_MISSING_NAME_MESSAGE,
};

/** WhatsApp injects these into RTL number runs; they make /^[0-3]$/ fail. */
const BIDI_CONTROL_CHARS = /[\u200E\u200F\u202A-\u202E]/g;

function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROL_CHARS, "");
}

/**
 * Opt-in forensic logging for the add/delete parsers, off unless
 * USER_MGMT_DEBUG=1.
 *
 * Exists because this flow is the one place where the pipeline hands the
 * handlers a string that differs from what the admin typed: everything upstream
 * of the orchestrator runs on PII-redacted text (see `redactPii` in
 * lib/security/guardrails.ts), so a parse failure here is far more often a
 * mismatch between the two strings than a genuinely malformed input. The trace
 * prints both, with code points, so that is visible in one log line instead of
 * being re-derived from a unit test that never sees the redacted form.
 *
 * Logs raw admin input verbatim — keep it off outside of an active
 * investigation.
 */
const USER_MGMT_DEBUG = process.env.USER_MGMT_DEBUG === "1";

function describeRaw(label: string, value: string): Record<string, unknown> {
  return {
    [`${label}_json`]: JSON.stringify(value),
    [`${label}_len`]: value.length,
    [`${label}_codepoints`]: Array.from(value).map(
      (char) => `${char}:U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
    ),
  };
}

export function isUserManagementButtonId(buttonId: string | undefined): boolean {
  return (
    buttonId === ADMIN_ACTION_ADD_USER ||
    buttonId === ADMIN_ACTION_DELETE_USER ||
    buttonId === ADMIN_ACTION_LIST_USERS
  );
}

/** Requester may manage a target whose privilege is equal or lower (higher numeric level). */
export function canManagePermissionLevel(
  requesterLevel: PermissionLevel,
  targetLevel: PermissionLevel
): boolean {
  return requesterLevel <= targetLevel;
}

function isPermissionLevel(value: number): value is PermissionLevel {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function tokenize(raw: string): string[] {
  return stripBidiControls(raw)
    .trim()
    .split(/[\s,]+/)
    .map(stripBidiControls)
    .filter((token) => token.length > 0);
}

export function parseUserManagementMenuChoice(
  query: string,
  buttonId?: string
): UserManagementMenuChoice | null {
  if (buttonId === ADMIN_ACTION_ADD_USER) return "add";
  if (buttonId === ADMIN_ACTION_DELETE_USER) return "delete";
  if (buttonId === ADMIN_ACTION_LIST_USERS) return "list";

  const text = stripBidiControls(query).trim();
  if (!text) return null;
  if (matchesAdminAnalyticsExitCommand(text)) return "cancel";

  if (
    /^\s*1[\.)]?\s*$/.test(text) ||
    /^\s*(?:הוסף\s*משתמש|add\s*user)\s*$/i.test(text) ||
    text === ADMIN_ACTION_ADD_USER
  ) {
    return "add";
  }
  if (
    /^\s*2[\.)]?\s*$/.test(text) ||
    /^\s*(?:מחק\s*משתמש|delete\s*user)\s*$/i.test(text) ||
    text === ADMIN_ACTION_DELETE_USER
  ) {
    return "delete";
  }
  if (
    /^\s*3[\.)]?\s*$/.test(text) ||
    /^\s*(?:טבלת\s*משתמשים|list\s*users)\s*$/i.test(text) ||
    text === ADMIN_ACTION_LIST_USERS
  ) {
    return "list";
  }

  return null;
}

/** `0`, `3`, `L1`, `l0` — the level as admins actually type it. */
const LEVEL_TOKEN = /^L?([0-3])$/i;

/**
 * Parses "name, phone, level" from one free-text WhatsApp line.
 *
 * Tolerant of both separators on purpose: ADD_USER_PROMPT shows commas,
 * ADD_FORMAT_RETRY shows spaces, and `tokenize` splits on either, so an admin
 * who mixes them still gets through. Field *order* is not fixed either — the
 * phone is identified by being the only token that normalises to a phone
 * number, and the level by matching LEVEL_TOKEN, so whatever is left is the
 * name. That is what lets "אח שלי 1 0543118077" and "L2 אח שלי 0543118077"
 * both resolve.
 *
 * The checks run phone → level → name so the returned reason names the field
 * the admin actually has to fix.
 */
export function parseAddUserInput(raw: string): ParseAddUserResult {
  const tokens = tokenize(raw);

  const trace = (
    result: ParseAddUserResult,
    meta: Record<string, unknown>
  ): ParseAddUserResult => {
    if (USER_MGMT_DEBUG) {
      logInfo("add_user_parse_trace", "parseAddUserInput result.", {
        ...describeRaw("raw", raw),
        tokens,
        phoneCandidate: null,
        normalizedPhone: null,
        levelCandidate: null,
        ...meta,
        outcome: result.success ? "SUCCESS" : result.reason,
      });
    }
    return result;
  };

  if (tokens.length < 3) {
    return trace({ success: false, reason: "NOT_ENOUGH_ARGS" }, {});
  }

  // Phone first. `normalizePhoneNumber` strips every non-digit, so this is the
  // one test that cannot be fooled by a Hebrew name or an L-prefixed level, and
  // it is immune to the bidi marks WhatsApp injects around number runs.
  let phoneIndex = -1;
  let phone: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const candidate = normalizePhoneNumber(tokens[i]);
    if (candidate) {
      phoneIndex = i;
      phone = candidate;
      break;
    }
  }

  if (phoneIndex === -1 || !phone) {
    return trace({ success: false, reason: "MISSING_PHONE" }, {});
  }

  const phoneMeta = { phoneCandidate: tokens[phoneIndex], normalizedPhone: phone };

  // Scanned from the end: the canonical format puts the level last, so a bare
  // 0–3 sitting inside the name cannot steal it.
  let levelIndex = -1;
  let level: PermissionLevel | null = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (i === phoneIndex) continue;
    const match = LEVEL_TOKEN.exec(stripBidiControls(tokens[i]));
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (!isPermissionLevel(parsed)) continue;
    levelIndex = i;
    level = parsed;
    break;
  }

  if (levelIndex === -1 || level === null) {
    return trace({ success: false, reason: "INVALID_LEVEL" }, phoneMeta);
  }

  const name = tokens
    .filter((_, index) => index !== phoneIndex && index !== levelIndex)
    .join(" ")
    .trim();

  const meta = { ...phoneMeta, levelCandidate: tokens[levelIndex] };

  if (!name) {
    return trace({ success: false, reason: "MISSING_NAME" }, meta);
  }

  return trace({ success: true, data: { name, phone, level } }, meta);
}

export function parseDeleteUserInput(raw: string): ParsedDeleteUserInput | null {
  const tokens = tokenize(raw);
  if (tokens.length < 2) return null;

  let phoneIndex = -1;
  let normalizedPhone: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const phone = normalizePhoneNumber(tokens[i]);
    if (phone) {
      phoneIndex = i;
      normalizedPhone = phone;
      break;
    }
  }

  if (phoneIndex === -1 || !normalizedPhone) return null;

  const nameTokens = tokens.filter((_, idx) => idx !== phoneIndex);
  const name = nameTokens.join(" ").trim();
  if (!name) return null;

  return { name, phone: normalizedPhone };
}

async function failInvalid(
  adminPhone: string,
  session: AdminSession,
  retryMessage: string
): Promise<UserManagementFlowResult> {
  if ((await recordInvalidAttempt(adminPhone, session)) >= MAX_INVALID_ATTEMPTS) {
    return { type: "text", answer: SESSION_ABANDONED_MESSAGE };
  }
  return { type: "text", answer: retryMessage };
}

async function sendUserManagementMenu(
  to: string,
  userLevel: PermissionLevel,
  signal?: AbortSignal | null
): Promise<void> {
  const buttons = [
    { id: ADMIN_ACTION_ADD_USER, title: "הוסף משתמש" },
    { id: ADMIN_ACTION_DELETE_USER, title: "מחק משתמש" },
  ];
  if (isAdminRole(userLevel)) {
    buttons.push({ id: ADMIN_ACTION_LIST_USERS, title: "טבלת משתמשים" });
  }

  await setAdminSession(to, "AWAITING_USER_MANAGEMENT_CHOICE");
  await sendWhatsAppInteractiveButtons({
    to,
    bodyText: isAdminRole(userLevel)
      ? "בחר את הפעולה שברצונך לבצע:\n1. הוסף משתמש\n2. מחק משתמש\n3. טבלת משתמשים"
      : "בחר את הפעולה שברצונך לבצע:\n1. הוסף משתמש\n2. מחק משתמש",
    buttons,
    signal,
  });
}

function formatUserTable(
  users: Array<{ phone_number: string; display_name: string; permission_level: number }>
): string {
  if (users.length === 0) return EMPTY_USER_TABLE_MESSAGE;
  const rows = users.map(
    (user) =>
      `${user.permission_level} | ${user.display_name || "—"} | ${user.phone_number}`
  );
  return [USER_TABLE_HEADER, ...rows].join("\n");
}

async function handleAddUserInput(
  adminPhone: string,
  query: string,
  commandText: string | undefined,
  requesterLevel: PermissionLevel,
  session: AdminSession
): Promise<UserManagementFlowResult> {
  // `query` has been through `redactPii`, which rewrites any Israeli phone
  // number to "[PHONE_REDACTED]" — parsing it can only ever yield MISSING_PHONE.
  // `commandText` is the same message before redaction, supplied for exactly
  // this reason (lib/domain/whatsapp/core/incomingMessageProcessor.ts). It falls back to
  // `query` for callers outside the WhatsApp pipeline, such as the evaluator.
  const parsed = parseAddUserInput(commandText ?? query);

  if (USER_MGMT_DEBUG) {
    logInfo("add_user_branch_trace", "handleAddUserInput branch selected.", {
      adminPhone,
      ...describeRaw("query", query),
      ...describeRaw("commandText", commandText ?? ""),
      usedCommandText: commandText !== undefined,
      outcome: parsed.success ? "SUCCESS" : parsed.reason,
      replyConstant: parsed.success ? null : ADD_PARSE_ERROR_MESSAGES[parsed.reason],
      // Echoed so a log line proves which build produced it.
      addInputExample: ADD_INPUT_EXAMPLE,
    });
  }

  if (!parsed.success) {
    return failInvalid(adminPhone, session, ADD_PARSE_ERROR_MESSAGES[parsed.reason]);
  }

  const { name, phone, level } = parsed.data;

  if (!canManagePermissionLevel(requesterLevel, level)) {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: HIERARCHY_DENIED_MESSAGE };
  }

  const inserted = await insertAdminManagedUser(phone, name, level);
  if (!inserted) {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: USER_EXISTS_MESSAGE };
  }

  await clearAdminSession(adminPhone);
  return { type: "text", answer: USER_ADDED_MESSAGE };
}

async function handleDeleteUserInput(
  adminPhone: string,
  query: string,
  commandText: string | undefined,
  requesterLevel: PermissionLevel,
  session: AdminSession
): Promise<UserManagementFlowResult> {
  // Same redaction problem as handleAddUserInput — see the note there.
  const parsed = parseDeleteUserInput(commandText ?? query);

  if (USER_MGMT_DEBUG) {
    logInfo("delete_user_branch_trace", "handleDeleteUserInput branch selected.", {
      adminPhone,
      ...describeRaw("query", query),
      ...describeRaw("commandText", commandText ?? ""),
      usedCommandText: commandText !== undefined,
      outcome: parsed ? "SUCCESS" : "PARSE_FAILED",
    });
  }

  if (!parsed) return failInvalid(adminPhone, session, DELETE_FORMAT_RETRY);

  const requesterPhone = normalizePhoneNumber(adminPhone) ?? adminPhone;
  if (parsed.phone === requesterPhone) {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: SELF_DELETE_DENIED_MESSAGE };
  }

  const target = await getUserByPhone(parsed.phone);
  if (target && !canManagePermissionLevel(requesterLevel, target.permission_level)) {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: HIERARCHY_DENIED_MESSAGE };
  }

  const deleted = await deleteAdminManagedUser(parsed.phone);
  if (!deleted) {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: USER_NOT_FOUND_MESSAGE };
  }

  await clearAdminSession(adminPhone);
  return { type: "text", answer: USER_DELETED_MESSAGE };
}

async function applyUserManagementChoice(
  adminPhone: string,
  choice: UserManagementMenuChoice,
  requesterLevel: PermissionLevel
): Promise<UserManagementFlowResult> {
  if (choice === "cancel") {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: USER_MANAGEMENT_CANCELLED_MESSAGE };
  }

  if (choice === "add") {
    await setAdminSession(adminPhone, "AWAITING_ADD_USER_DETAILS");
    return { type: "prompt_sent", promptText: ADD_USER_PROMPT };
  }

  if (choice === "delete") {
    await setAdminSession(adminPhone, "AWAITING_DELETE_USER_DETAILS");
    return { type: "prompt_sent", promptText: DELETE_USER_PROMPT };
  }

  if (!isAdminRole(requesterLevel)) {
    return { type: "text", answer: LIST_USERS_DENIED_MESSAGE };
  }
  await clearAdminSession(adminPhone);
  const users = await getAllManagedUsers();
  return { type: "text", answer: formatUserTable(users) };
}

export async function resolveUserManagementFlow(input: {
  adminPhone: string;
  /** PII-redacted text. Safe to log; used for menu/heuristic matching. */
  query: string;
  /**
   * The same message *before* redaction, for the deterministic add/delete
   * parsers only — a redacted phone number carries no digits, so parsing
   * `query` can never succeed. Never logged (outside USER_MGMT_DEBUG),
   * persisted, traced, or sent to an LLM. Optional so non-WhatsApp callers
   * keep working.
   */
  commandText?: string;
  buttonId?: string;
  requesterPermissionLevel: PermissionLevel;
  signal?: AbortSignal | null;
}): Promise<UserManagementFlowResult> {
  if (!isElevatedRole(input.requesterPermissionLevel)) {
    logError(
      "user_management_permission_violation",
      new Error("non-elevated role reached user management flow"),
      {
        adminPhone: input.adminPhone,
        requesterPermissionLevel: input.requesterPermissionLevel,
      }
    );
    return { type: "text", answer: "" };
  }

  const session = await getAdminSession(input.adminPhone);
  const menuChoice = parseUserManagementMenuChoice(input.query, input.buttonId);

  if (input.buttonId && isUserManagementButtonId(input.buttonId) && menuChoice) {
    logInfo("user_management_choice_resolved", "User-management button selected.", {
      adminPhone: input.adminPhone,
      choice: menuChoice,
    });
    return applyUserManagementChoice(
      input.adminPhone,
      menuChoice,
      input.requesterPermissionLevel
    );
  }

  if (input.buttonId && isUserManagementButtonId(input.buttonId)) {
    return { type: "text", answer: UNKNOWN_BUTTON_MESSAGE };
  }

  if (session && isUserManagementSessionMode(session.mode) && menuChoice === "cancel") {
    await clearAdminSession(input.adminPhone);
    return { type: "text", answer: USER_MANAGEMENT_CANCELLED_MESSAGE };
  }

  if (session?.mode === "AWAITING_USER_MANAGEMENT_CHOICE") {
    if (menuChoice && menuChoice !== "cancel") {
      logInfo("user_management_choice_resolved", "User-management text selected.", {
        adminPhone: input.adminPhone,
        choice: menuChoice,
      });
      return applyUserManagementChoice(
        input.adminPhone,
        menuChoice,
        input.requesterPermissionLevel
      );
    }
    if (matchesUserManagementHeuristic(input.query)) {
      await sendUserManagementMenu(
        input.adminPhone,
        input.requesterPermissionLevel,
        input.signal
      );
      return { type: "interactive_sent" };
    }
    return failInvalid(input.adminPhone, session, USER_MANAGEMENT_MENU_RETRY);
  }

  if (session?.mode === "AWAITING_ADD_USER_DETAILS") {
    return handleAddUserInput(
      input.adminPhone,
      input.query,
      input.commandText,
      input.requesterPermissionLevel,
      session
    );
  }

  if (session?.mode === "AWAITING_DELETE_USER_DETAILS") {
    return handleDeleteUserInput(
      input.adminPhone,
      input.query,
      input.commandText,
      input.requesterPermissionLevel,
      session
    );
  }

  await sendUserManagementMenu(
    input.adminPhone,
    input.requesterPermissionLevel,
    input.signal
  );
  return { type: "interactive_sent" };
}

// -------------------------------------------------------------------------
// Orchestrator
// -------------------------------------------------------------------------

export type BaselineDeliveryKind = "text" | "interactive_sent" | "already_sent_prompt";

export interface BaselineProcessResult {
  kind: BaselineDeliveryKind;
  answer: string;
  ragMetrics: BaselineRagCoreResult | null;
  intent: BaselineIntent;
}

export interface BaselineProcessInput {
  /** WhatsApp E.164 sender id (phone). */
  senderPhone: string;
  /**
   * Already redacted and safety-screened by
   * lib/domain/whatsapp/core/incomingMessageProcessor.ts. Never raw webhook text.
   */
  query: string;
  /**
   * The same message before `redactPii`, for deterministic admin-command
   * parsing only. Reaches nothing but `resolveUserManagementFlow`: not
   * retrieval, not the LLM, not history, not the metrics sink. Redaction turns
   * every phone number into "[PHONE_REDACTED]", which is unparseable by the
   * add/delete user flows — that is the only reason this field exists.
   */
  commandText?: string;
  userContext: UserContext;
  priorMessages?: ChatMessage[];
  buttonId?: string;
  /** Job deadline / shutdown cancellation, forwarded to every LLM call. */
  signal?: AbortSignal | null;
}

const EMPTY_DLS = { score: 0, totalChunks: 0, unauthorizedChunks: 0, passed: true } as const;

/** Outcome of the single synchronous pre-flight pass over the query. */
type LexicalVerdict = { kind: "chat_history" } | { kind: "rag" };

/**
 * Single O(n) lexical sweep run before any I/O.
 *
 * Safety screening no longer lives here — it moved upstream to
 * `evaluateInboundSafety`, which runs before the first database write so that
 * nothing is persisted or traced ahead of the distress check. What remains is
 * pure routing, kept synchronous and LLM-free so it adds nothing to TTFT.
 */
function sweepQueryLexically(query: string, userContext: UserContext): LexicalVerdict {
  // Only L0/L1 may pull staff chat history.
  if (isElevatedRole(userContext.permissionLevel) && matchesChatHistoryHeuristic(query)) {
    return { kind: "chat_history" };
  }

  return { kind: "rag" };
}

export async function processBaselineQuery(
  input: BaselineProcessInput
): Promise<BaselineProcessResult> {
  const {
    query,
    commandText,
    userContext,
    priorMessages = [],
    buttonId,
    senderPhone,
    signal,
  } = input;

  // Defence in depth. The processor is the designated safety gate, but this
  // function is also reachable from scripts/evaluate_runner.ts and any future
  // caller. If distress text ever arrives here it means the gate was bypassed —
  // fail closed with the handoff and log loudly rather than calling an LLM.
  if (containsMandatoryHandoffSignals(query)) {
    logError(
      "safety_gate_bypassed",
      new Error("Distress signals reached the orchestrator"),
      { senderPhone, permissionLevel: userContext.permissionLevel }
    );
    return {
      kind: "text",
      answer: MANDATORY_HANDOFF_RESPONSE_HE,
      ragMetrics: {
        answer: MANDATORY_HANDOFF_RESPONSE_HE,
        retrievedChunks: [],
        dls: { ...EMPTY_DLS },
        latencyMs: 0,
      },
      intent: "RAG_INQUIRY",
    };
  }

  let adminSession = isElevatedRole(userContext.permissionLevel)
    ? await getAdminSession(senderPhone)
    : null;

  // A fresh chat-history request must escape an in-progress add/delete prompt
  // so a leftover user-management session cannot swallow the rest of the bot.
  if (
    adminSession &&
    isUserManagementSessionMode(adminSession.mode) &&
    matchesChatHistoryHeuristic(query) &&
    !isUserManagementButtonId(buttonId)
  ) {
    await clearAdminSession(senderPhone);
    adminSession = null;
  }

  const userManagementActive =
    !!adminSession && isUserManagementSessionMode(adminSession.mode);
  const userManagementRequested =
    isElevatedRole(userContext.permissionLevel) &&
    (isUserManagementButtonId(buttonId) ||
      userManagementActive ||
      matchesUserManagementHeuristic(query));

  if (userManagementRequested) {
    const managed = await resolveUserManagementFlow({
      adminPhone: senderPhone,
      query,
      commandText,
      buttonId,
      requesterPermissionLevel: userContext.permissionLevel,
      signal,
    });
    if (managed.type === "interactive_sent") {
      return { kind: "interactive_sent", answer: "", ragMetrics: null, intent: "CHAT_HISTORY" };
    }
    if (managed.type === "prompt_sent") {
      return {
        kind: "already_sent_prompt",
        answer: managed.promptText,
        ragMetrics: null,
        intent: "CHAT_HISTORY",
      };
    }
    // Always deliver user-management text, including ADD_FORMAT_RETRY. Falling
    // through to L0/RAG is what made format-retry prompts look like a silent drop.
    return { kind: "text", answer: managed.answer, ragMetrics: null, intent: "CHAT_HISTORY" };
  }

  // Task 2 (context-aware routing): checked before the lexical sweep / RAG
  // fallback so a follow-up question about a just-generated report never gets
  // treated as a generic RAG_INQUIRY. A button click or an in-progress admin
  // session is an explicit fresh action, so only free text outside those flows
  // is eligible to be treated as an analytics follow-up.
  // resolveAdminAnalyticsFollowUp re-validates the admin role internally.
  if (isAdminRole(userContext.permissionLevel) && !buttonId && !adminSession) {
    const analytics = await resolveAdminAnalyticsFollowUp({
      adminPhone: senderPhone,
      query,
      requesterPermissionLevel: userContext.permissionLevel,
      signal,
    });
    if (analytics.handled) {
      return { kind: "text", answer: analytics.answer, ragMetrics: null, intent: "CHAT_HISTORY" };
    }
  }

  const sweep = sweepQueryLexically(query, userContext);

  // An interactive button reply is always a chat-history menu selection.
  const intent: BaselineIntent =
    buttonId || sweep.kind === "chat_history" ? "CHAT_HISTORY" : "RAG_INQUIRY";

  if (isAdminRole(userContext.permissionLevel)) {
    const l0 = await resolveL0AdminFlow({
      adminPhone: senderPhone,
      query,
      buttonId,
      isChatHistoryIntent: intent === "CHAT_HISTORY",
      // Trusted, DB-resolved level (never from buttonId/query) — see the guard at
      // the top of resolveL0AdminFlow.
      requesterPermissionLevel: userContext.permissionLevel,
      signal,
    });

    if (l0.type === "interactive_sent") {
      return { kind: "interactive_sent", answer: "", ragMetrics: null, intent };
    }
    if (l0.type === "prompt_sent") {
      return { kind: "already_sent_prompt", answer: l0.promptText, ragMetrics: null, intent };
    }
    if (l0.type === "text" && l0.answer) {
      return { kind: "text", answer: l0.answer, ragMetrics: null, intent };
    }
    // L0 non–chat-history queries fall through to standard RAG below.
  }

  if (isManagerRole(userContext.permissionLevel) && intent === "CHAT_HISTORY") {
    const answer = await runL1DailyStaffSummary(userContext.permissionLevel, signal);
    return { kind: "text", answer, ragMetrics: null, intent };
  }

  // Greetings and small talk are handled by the system directives inside the main
  // generation call, so no separate classification hop is needed here.
  const rag = await runBaselineRagCore({
    query,
    userContext,
    priorMessages,
    signal,
  });

  return {
    kind: "text",
    answer: rag.answer,
    ragMetrics: rag,
    intent: "RAG_INQUIRY",
  };
}
