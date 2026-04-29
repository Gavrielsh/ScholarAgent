import type { AgentGraphState } from "@/lib/agent/state";
import { getLlmAdapter } from "@/lib/llm/adapter";

function formatWhatsAppResponse(state: AgentGraphState): string {
  const topContext = state.gathered_context.slice(0, 4);

  const evidenceLines =
    topContext.length > 0
      ? topContext
          .map((ctx, index) => `${index + 1}. [${ctx.source}] ${ctx.content.slice(0, 180)}`)
          .join("\n")
      : "No external context found yet.";

  // TODO: Replace template formatter with LLM synthesis chain for higher quality responses.
  return [
    `Mission: ${state.mission || "No mission provided."}`,
    "",
    "Quick Findings:",
    evidenceLines,
    "",
    "Recommended Next Action:",
    "Use this as an initial decision-support draft and ask a follow-up question for deeper analysis.",
  ].join("\n");
}

export async function responderNode(
  state: AgentGraphState
): Promise<Partial<AgentGraphState>> {
  const adapter = getLlmAdapter();
  const fallback = formatWhatsAppResponse(state);

  const gatheredContextBlock =
    state.gathered_context.length > 0
      ? state.gathered_context
          .slice(0, 8)
          .map((ctx, i) => `${i + 1}. (${ctx.source}) ${ctx.content}`)
          .join("\n")
      : "No context gathered.";

  let finalResponse = fallback;
  try {
    finalResponse = await adapter.generateText({
      messages: [
        {
          role: "system",
          content:
            "You are an educational decision-support assistant. Keep answers concise, structured, and WhatsApp-friendly.",
        },
        {
          role: "user",
          content: [
            `Mission: ${state.mission}`,
            "",
            "Gathered context:",
            gatheredContextBlock,
            "",
            "Return a practical response with 3 sections:",
            "1) What we know",
            "2) Suggested action",
            "3) One follow-up question",
          ].join("\n"),
        },
      ],
      temperature: 0.2,
    });
  } catch {
    // TODO: Add structured telemetry/tracing for adapter failures.
    finalResponse = fallback;
  }

  return {
    final_response: finalResponse,
    messages: [
      ...state.messages,
      {
        role: "assistant",
        content: finalResponse,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}
