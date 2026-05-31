import type { AgentGraphState } from "@/lib/agent/state";
import { ROLE_DESCRIPTIONS } from "@/lib/auth/types";
import { getLlmAdapter } from "@/lib/llm/adapter";



function formatWhatsAppResponse(state: AgentGraphState): string {
  const topContext = state.gathered_context.slice(0, 4);
  const responseMission = state.rewrittenQuery ?? state.mission;

  const evidenceLines =
    topContext.length > 0
      ? topContext
          .map((ctx, index) => `${index + 1}. [${ctx.source}] ${ctx.content.slice(0, 180)}`)
          .join("\n")
      : "לא נמצא הקשר חיצוני.";

  return [
    `מטרה: ${responseMission || "לא סופקה מטרה."}`,
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
  if (state.final_response) {
    return {
      messages: [
        ...state.messages,
        { role: "assistant", content: state.final_response, createdAt: new Date().toISOString() },
      ],
    };
  }

  const adapter = getLlmAdapter();
  const fallback = formatWhatsAppResponse(state);
  const responseMission = state.rewrittenQuery ?? state.mission;

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
    const safetyInstruction =
      state.intentCategory === "BORDERLINE" || state.intentCategory === "PROBLEMATIC"
        ? "The original message was privacy-sensitive or emotionally loaded. Acknowledge carefully, explain the issue generally, and offer an educational alternative. Do not identify, rank, label, or infer anything about real children."
        : "The request is a valid educational request. Answer normally within the educational scope.";
    
    finalResponse = await adapter.generateText({
      messages: [
        {
          role: "system",
          content:
`הנחיית אורך: סכם ותמצת את התשובה שצריך להחזיר למשתמש. על התשובה להיות מדויקת, עניינית, ומוגבלת לעד 300 מילים.
You are a mentor in the 'Adam LeAdam Ze Lev' project.
The user is a ${roleName}. Adjust your vocabulary, depth of detail,
and tone to match their needs as defined in the target audience documents.
ענה תמיד בעברית בלבד, בטון חינוכי ולא שיפוטי.
מטרת הבוט: לסייע למנטורים לבנות פעילויות וסדנאות.
Safety instruction: ${safetyInstruction}
Audience instruction for this user only: ${roleDescription}
IMPORTANT FORMATTING RULE: Format your response for WhatsApp. Use a single asterisk for bold text (*text*) and NEVER use double asterisks (**text**).`,
        },
        {
          role: "user",
          content: [
            `פנייה מקורית: ${state.mission}`,
            `נוסח בטוח פנימי לחיפוש/מענה: ${responseMission}`,
            `קטגוריית כוונה: ${state.intentCategory}`,
            `ציון סיכון: ${state.safetyRiskScore}`,
            `תפקיד משתמש: ${roleName} (L${permissionLevel})`,
            "",
            "הקשר שנאסף:",
            gatheredContextBlock,
          ].join("\n"),
        },
      ],
      temperature: 0.2,
    });
    finalResponse = finalResponse.replace(/\*\*/g, "*");
  } catch {
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