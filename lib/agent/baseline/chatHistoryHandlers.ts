import { getLlmAdapter } from "@/lib/llm/adapter";
import {
  fetchTodayChatHistoryForPhone,
  fetchTodayStaffChatHistories,
  findUsersByDisplayName,
  formatStaffRowsAsDirectReport,
  formatStaffRowsForLlm,
} from "@/lib/chat/adminHistory";
import {
  clearL0AdminSession,
  getL0AdminSession,
  setL0AdminSession,
} from "@/lib/chat/l0AdminSession";
import { sendWhatsAppInteractiveButtons } from "@/lib/whatsapp/messaging";

import { resolveFastModel } from "./intentRouter";

const L0_BUTTON_DAILY = "l0_daily_summary";
const L0_BUTTON_SPECIFIC = "l0_specific_user";

const ONE_PARAGRAPH_SUMMARY_PROMPT =
  "סכם את אינטראקציות היום עם משתמשי L2 ו-L3 במשפט אחד בלבד — פסקה אחת קצרה בעברית, ללא רשימות.";

async function summarizeStaffDay(rawData: string): Promise<string> {
  const adapter = getLlmAdapter();
  let answer = await adapter.generateText({
    model: resolveFastModel(),
    temperature: 0.2,
    messages: [
      { role: "system", content: ONE_PARAGRAPH_SUMMARY_PROMPT },
      { role: "user", content: rawData },
    ],
  });
  answer = answer.replace(/\*\*/g, "*");
  return answer.trim();
}

export async function runL1DailyStaffSummary(): Promise<string> {
  const rows = await fetchTodayStaffChatHistories([2, 3]);
  const raw = formatStaffRowsForLlm(rows);
  return summarizeStaffDay(raw);
}

export async function sendL0HistoryMenu(to: string): Promise<void> {
  setL0AdminSession(to, "awaiting_menu_choice");
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
  buttonId: string
): Promise<{ answer: string; clearSession: boolean } | { sentPrompt: true }> {
  if (buttonId === L0_BUTTON_DAILY) {
    clearL0AdminSession(adminPhone);
    const answer = await runL1DailyStaffSummary();
    return { answer, clearSession: true };
  }

  if (buttonId === L0_BUTTON_SPECIFIC) {
    setL0AdminSession(adminPhone, "awaiting_user_name");
    return {
      sentPrompt: true,
    };
  }

  clearL0AdminSession(adminPhone);
  return {
    answer: "בחירה לא מזוהה. שלח שוב בקשה להיסטוריית שיחות.",
    clearSession: true,
  };
}

export const L0_SPECIFIC_USER_PROMPT =
  "הקלד/י את שם המשתמש (כפי שמופיע במערכת) כדי לקבל את היסטוריית השיחה שלו להיום.";

export async function handleL0SpecificUserName(nameInput: string): Promise<string> {
  const matches = await findUsersByDisplayName(nameInput);
  if (matches.length === 0) {
    return `לא נמצא משתמש בשם "${nameInput}". נסה שם מדויק יותר.`;
  }

  const user = matches[0];
  const label = user.displayName ?? user.phoneNumber;
  const rows = await fetchTodayChatHistoryForPhone(user.phoneNumber);
  return formatStaffRowsAsDirectReport(rows, label);
}

export async function resolveL0AdminFlow(input: {
  adminPhone: string;
  query: string;
  buttonId?: string;
  isChatHistoryIntent: boolean;
}): Promise<
  | { type: "text"; answer: string }
  | { type: "interactive_sent" }
  | { type: "prompt_sent"; promptText: string }
> {
  const session = getL0AdminSession(input.adminPhone);

  if (input.buttonId) {
    const result = await handleL0ButtonReply(input.adminPhone, input.buttonId);
    if ("sentPrompt" in result) {
      return { type: "prompt_sent", promptText: L0_SPECIFIC_USER_PROMPT };
    }
    return { type: "text", answer: result.answer };
  }

  if (session?.mode === "awaiting_user_name") {
    clearL0AdminSession(input.adminPhone);
    const answer = await handleL0SpecificUserName(input.query);
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

export async function resolveL1ChatHistoryFlow(): Promise<string> {
  return runL1DailyStaffSummary();
}
