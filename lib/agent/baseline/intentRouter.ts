// Lexical intent gate. Deliberately LLM-free: an extra model round-trip purely to
// pick a label added a full network hop to TTFT on every message. RAG_INQUIRY vs
// chit-chat is now resolved inside the single main generation call instead.

import { CLAUDE_FAST_MODEL } from "@/lib/llm/providers/claude";

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
const ANALYTICS_EXIT_HEURISTICS: RegExp[] = [/^\s*(cancel|exit|בטל|ביטול|יציאה|צא)\s*$/i];

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
