import { getLlmAdapter } from "@/lib/llm/adapter";
import { isAdminRole } from "@/lib/auth/roles";
import type { PermissionLevel } from "@/lib/auth/types";
import {
  fetchTodayChatHistoryForPhone,
  findUsersByDisplayName,
  formatStaffRowsAsDirectReport,
  loadTodayStaffContext,
} from "@/lib/chat/adminHistory";
import { enterAdminAnalyticsMode } from "@/lib/chat/adminAnalyticsSession";
import {
  clearAdminSession,
  getAdminSession,
  isUserManagementSessionMode,
  MAX_INVALID_ATTEMPTS,
  recordInvalidAttempt,
  SESSION_ABANDONED_MESSAGE,
  setAdminSession,
} from "@/lib/chat/adminSession";
import { logError, logInfo } from "@/lib/logger";
import { formatWhatsAppMarkdown } from "@/lib/whatsapp/formatting";
import { sendWhatsAppInteractiveButtons } from "@/lib/whatsapp/messaging";

import { matchesAdminAnalyticsExitCommand, resolveFastModel } from "./intentRouter";

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
