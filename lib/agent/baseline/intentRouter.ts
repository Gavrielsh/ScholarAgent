import type { UserContext } from "@/lib/auth/types";
import { isElevatedRole } from "@/lib/auth/roles";
import { getLlmAdapter } from "@/lib/llm/adapter";
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

function matchesChatHistoryHeuristic(query: string): boolean {
  return CHAT_HISTORY_HEURISTICS.some((pattern) => pattern.test(query));
}

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

function parseIntentFromLlm(raw: string): BaselineIntent {
  const normalized = raw.trim().toUpperCase();
  if (normalized.includes("CHAT_HISTORY")) return "CHAT_HISTORY";
  return "RAG_INQUIRY";
}

/**
 * Fast intent gate before pgvector retrieval. Only L0/L1 can trigger CHAT_HISTORY routing.
 */
export async function classifyBaselineIntent(
  query: string,
  userContext: UserContext
): Promise<BaselineIntent> {
  if (!isElevatedRole(userContext.permissionLevel)) {
    return "RAG_INQUIRY";
  }

  if (matchesChatHistoryHeuristic(query)) {
    return "CHAT_HISTORY";
  }

  const adapter = getLlmAdapter();
  try {
    const raw = await adapter.generateText({
      model: resolveFastModel(),
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            'Classify the user message into exactly one label: "CHAT_HISTORY" or "RAG_INQUIRY". ' +
            "CHAT_HISTORY = requests to summarize, review, or export today's WhatsApp conversations of staff/mentors. " +
            "RAG_INQUIRY = educational content questions. Reply with the label only.",
        },
        { role: "user", content: query },
      ],
    });
    return parseIntentFromLlm(raw);
  } catch {
    return "RAG_INQUIRY";
  }
}
