import type { ChatMessage } from "@/lib/agent/state";
import type { ChatHistoryEntry } from "@/lib/chat/history";

/** Conservative chars-per-token ratio for Hebrew/Latin mixed corpora. */
const CHARS_PER_TOKEN = Number(process.env.CHAT_CHARS_PER_TOKEN ?? 4);

/** Hard cap on a single inbound user turn (anti abuse / injection payloads). */
const MAX_INBOUND_MESSAGE_CHARS = Number(process.env.CHAT_MAX_INBOUND_CHARS ?? 8_000);

/** Total character budget for prior conversation passed to the LLM. */
const MAX_CONTEXT_CHARS = Number(process.env.CHAT_MAX_CONTEXT_CHARS ?? 24_000);

/** Approximate token ceiling derived from char budget (default ~6k tokens). */
const MAX_CONTEXT_TOKENS = Number(
  process.env.CHAT_MAX_CONTEXT_TOKENS ?? Math.floor(MAX_CONTEXT_CHARS / CHARS_PER_TOKEN)
);

const DEFAULT_MAX_TURNS = Number(process.env.CHAT_MAX_HISTORY_TURNS ?? 10);
export const MAX_HISTORY_TURNS = DEFAULT_MAX_TURNS;

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

export function truncateInboundMessage(body: string): string {
  return truncateText(body.trim(), MAX_INBOUND_MESSAGE_CHARS);
}

/**
 * Converts persisted history into LLM messages, applying turn cap AND character/token budget.
 * Newest turns are kept; older turns drop first when the budget is exceeded.
 */
export function buildBoundedConversationContext(
  rawEntries: ChatHistoryEntry[],
  options?: { maxTurns?: number; maxChars?: number }
): ChatMessage[] {
  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxChars = options?.maxChars ?? MAX_CONTEXT_CHARS;

  const conversational = rawEntries.filter(
    (e): e is ChatHistoryEntry & { role: "user" | "assistant" } =>
      e.role === "user" || e.role === "assistant"
  );

  const turnCap = Math.max(0, maxTurns) * 2;
  let selected = conversational.slice(-turnCap);

  const toMessages = (entries: typeof selected): ChatMessage[] =>
    entries.map((e) => ({
      role: e.role,
      content: e.content,
      createdAt: e.timestamp,
    }));

  let messages = toMessages(selected);
  let totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);

  while (totalChars > maxChars && selected.length > 2) {
    selected = selected.slice(2);
    messages = toMessages(selected);
    totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  }

  if (totalChars > maxChars && messages.length > 0) {
    const last = messages[messages.length - 1];
    const othersChars = totalChars - last.content.length;
    const remaining = Math.max(200, maxChars - othersChars);
    messages[messages.length - 1] = {
      ...last,
      content: truncateText(last.content, remaining),
    };
  }

  const tokenEstimate = estimateTokens(messages.map((m) => m.content).join("\n"));
  if (tokenEstimate > MAX_CONTEXT_TOKENS && messages.length > 0) {
    const ratio = MAX_CONTEXT_TOKENS / Math.max(1, tokenEstimate);
    messages = messages.map((m) => ({
      ...m,
      content: truncateText(m.content, Math.floor(m.content.length * ratio)),
    }));
  }

  return messages;
}
