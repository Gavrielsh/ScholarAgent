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
  clearL0AdminSession,
  getL0AdminSession,
  setL0AdminSession,
} from "@/lib/chat/l0AdminSession";
import { logError } from "@/lib/logger";
import { formatWhatsAppMarkdown } from "@/lib/whatsapp/formatting";
import { sendWhatsAppInteractiveButtons } from "@/lib/whatsapp/messaging";

import { resolveFastModel } from "./intentRouter";

const L0_BUTTON_DAILY = "l0_daily_summary";
const L0_BUTTON_SPECIFIC = "l0_specific_user";

const STAFF_ONLY_SUMMARY_PROMPT =
  "סכם את אינטראקציות היום עם משתמשי L2 ו-L3 במשפט אחד בלבד — פסקה אחת קצרה בעברית, ללא רשימות.";
const FULL_SCOPE_SUMMARY_PROMPT =
  "סכם את אינטראקציות היום עם כל המשתמשים (L0 עד L3) במשפט אחד בלבד — פסקה אחת קצרה בעברית, ללא רשימות.";

async function summarizeStaffDay(
  rawData: string,
  requesterPermissionLevel: PermissionLevel
): Promise<string> {
  const systemPrompt = isAdminRole(requesterPermissionLevel)
    ? FULL_SCOPE_SUMMARY_PROMPT
    : STAFF_ONLY_SUMMARY_PROMPT;
  const adapter = getLlmAdapter();
  const answer = await adapter.generateText({
    model: resolveFastModel(),
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: rawData },
    ],
  });
  return formatWhatsAppMarkdown(answer);
}

export async function runL1DailyStaffSummary(
  requesterPermissionLevel: PermissionLevel
): Promise<string> {
  // Report scope (L0 → all tiers, everyone else → L2/L3) is resolved inside
  // fetchTodayStaffChatHistories from this trusted, DB-derived level - never from
  // an externally-supplied filter.
  const { formatted } = await loadTodayStaffContext(requesterPermissionLevel);
  return summarizeStaffDay(formatted, requesterPermissionLevel);
}

export async function sendL0HistoryMenu(to: string): Promise<void> {
  await setL0AdminSession(to, "awaiting_menu_choice");
  await sendWhatsAppInteractiveButtons({
    to,
    bodyText: "בחר סוג דוח היסטוריית שיחות:",
    buttons: [
      { id: L0_BUTTON_DAILY, title: "סיכום יומי" },
      { id: L0_BUTTON_SPECIFIC, title: "משתמש ספציפי" },
    ],
  });
}

export async function handleL0ButtonReply(
  adminPhone: string,
  buttonId: string,
  requesterPermissionLevel: PermissionLevel
): Promise<{ answer: string; clearSession: boolean } | { sentPrompt: true }> {
  if (buttonId === L0_BUTTON_DAILY) {
    await clearL0AdminSession(adminPhone);
    const answer = await runL1DailyStaffSummary(requesterPermissionLevel);
    // Task 2: a report was just generated, so free-text follow-up questions from
    // this admin should now route to the DB-grounded analytics handler instead of
    // falling back to RAG document search.
    await enterAdminAnalyticsMode(adminPhone);
    return { answer, clearSession: true };
  }

  if (buttonId === L0_BUTTON_SPECIFIC) {
    await setL0AdminSession(adminPhone, "awaiting_user_name");
    return {
      sentPrompt: true,
    };
  }

  await clearL0AdminSession(adminPhone);
  return {
    answer: "בחירה לא מזוהה. שלח שוב בקשה להיסטוריית שיחות.",
    clearSession: true,
  };
}

export const L0_SPECIFIC_USER_PROMPT =
  "הקלד/י את שם המשתמש (כפי שמופיע במערכת) כדי לקבל את היסטוריית השיחה שלו להיום.";

export async function handleL0SpecificUserName(
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

  const session = await getL0AdminSession(input.adminPhone);

  if (input.buttonId) {
    const result = await handleL0ButtonReply(
      input.adminPhone,
      input.buttonId,
      input.requesterPermissionLevel
    );
    if ("sentPrompt" in result) {
      return { type: "prompt_sent", promptText: L0_SPECIFIC_USER_PROMPT };
    }
    return { type: "text", answer: result.answer };
  }

  if (session?.mode === "awaiting_user_name") {
    await clearL0AdminSession(input.adminPhone);
    const answer = await handleL0SpecificUserName(input.query, input.requesterPermissionLevel);
    // Same rationale as the daily-summary branch above: a report was just
    // generated, so enable DB-grounded follow-up Q&A for this admin.
    await enterAdminAnalyticsMode(input.adminPhone);
    return { type: "text", answer };
  }

  if (session?.mode === "awaiting_menu_choice") {
    return {
      type: "text",
      answer: "אנא בחר אחת מהאפשרויות בכפתורים שנשלחו, או שלח בקשה חדשה להיסטוריית שיחות.",
    };
  }

  if (input.isChatHistoryIntent) {
    await sendL0HistoryMenu(input.adminPhone);
    return { type: "interactive_sent" };
  }

  return { type: "text", answer: "" };
}


