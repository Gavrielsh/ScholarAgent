import { getLlmAdapter } from "@/lib/llm/adapter";
import { isAdminRole } from "@/lib/auth/roles";
import type { PermissionLevel } from "@/lib/auth/types";
import { loadTodayStaffContext } from "@/lib/chat/adminHistory";
import {
  exitAdminAnalyticsMode,
  isInAdminAnalyticsMode,
} from "@/lib/chat/adminAnalyticsSession";
import { logWarn } from "@/lib/logger";

import { matchesAdminAnalyticsExitCommand, resolveFastModel } from "./intentRouter";

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
async function isAnalyticalQuery(query: string): Promise<boolean> {
  try {
    const raw = await getLlmAdapter().generateText({
      model: resolveFastModel(),
      temperature: 0,
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
  requesterPermissionLevel: PermissionLevel
): Promise<string> {
  const { formatted } = await loadTodayStaffContext(requesterPermissionLevel);

  const answer = await getLlmAdapter().generateText({
    model: resolveFastModel(),
    temperature: 0.2,
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

  const analytical = await isAnalyticalQuery(input.query);
  if (!analytical) {
    // Ambiguous/unrelated query: gracefully exit the mode and let the orchestrator's
    // normal RAG path answer it, instead of forcing an analytics answer.
    await exitAdminAnalyticsMode(input.adminPhone);
    return { handled: false };
  }

  const answer = await answerFromChatHistory(input.query, input.requesterPermissionLevel);
  return { handled: true, answer };
}
