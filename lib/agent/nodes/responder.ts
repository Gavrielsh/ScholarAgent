import type { AgentGraphState } from "@/lib/agent/state";
import { ROLE_DESCRIPTIONS } from "@/lib/auth/types";
import { getLlmAdapter } from "@/lib/llm/adapter";

function formatWhatsAppResponse(state: AgentGraphState): string {
  const topContext = state.gathered_context.slice(0, 4);

  const evidenceLines =
    topContext.length > 0
      ? topContext
          .map((ctx, index) => `${index + 1}. [${ctx.source}] ${ctx.content.slice(0, 180)}`)
          .join("\n")
      : "לא נמצא הקשר חיצוני.";

  // TODO: Replace template formatter with LLM synthesis chain for higher quality responses.
  return [
    `מטרה: ${state.mission || "לא סופקה מטרה."}`,
    "",
    "מה ידוע כרגע:",
    evidenceLines,
    "",
    "צעד מומלץ:",
    "זהו ניסוח ראשוני לקבלת החלטה. מומלץ לשאול שאלת המשך כדי לדייק את ההמלצה.",
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
    if (!state.user_context) {
      throw new Error("Missing user context for role-aware response generation.");
    }

    const roleName = state.user_context.roleName;
    const permissionLevel = state.user_context.permissionLevel;
    const roleDescription = ROLE_DESCRIPTIONS[permissionLevel];
    finalResponse = await adapter.generateText({
      messages: [
        {
          role: "system",
          content:
            `You are a mentor in the 'Adam LeAdam Ze Lev' project. The user is a ${roleName}. Adjust your vocabulary, depth of detail, and tone to match their needs as defined in the target audience documents.
ענה תמיד בעברית, בצורה קצרה ומעשית לוואטסאפ.
Audience instruction for this user only: ${roleDescription}`,
        },
        {
          role: "user",
          content: [
            `מטרה: ${state.mission}`,
            `תפקיד משתמש: ${roleName} (L${permissionLevel})`,
            "",
            "הקשר שנאסף:",
            gatheredContextBlock,
            "",
            "החזר תשובה מעשית עם 3 סעיפים:",
            "1) מה ידוע",
            "2) פעולה מומלצת",
            "3) שאלת המשך אחת",
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
