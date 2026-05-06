import type { AgentGraphState } from "@/lib/agent/state";
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
    const roleName = state.user_context?.roleName ?? "קהל פתוח / הורים";
    const permissionLevel = state.user_context?.permissionLevel ?? 4;
    finalResponse = await adapter.generateText({
      messages: [
        {
          role: "system",
          content:
            `You are a mentor in the 'Adam LeAdam Ze Lev' project. The user is a ${roleName}. Adjust your vocabulary, depth of detail, and tone to match their needs as defined in the target audience documents.
ענה תמיד בעברית, בצורה קצרה ומעשית לוואטסאפ.
מיפוי קהלים:
L0 צוות מטה: תמונת מצב מלאה, נתונים טכניים ואנליטיקה רוחבית.
L1 מנהלות הכשרה: הנחיה מקצועית, תובנות פדגוגיות וסיכומי ניהול.
L2 סטודנטים/יועצות: לוגיסטיקה, פרוטוקולי משמעת ותובנות התנהגות לזוגות ספציפיים.
L3 חונכים/בוגרים: טיפים פרקטיים מהשטח, רעיונות לפעילות וניהול משבר בשפה פשוטה.
L4 קהל פתוח/הורים: מידע כללי, חזון הפרויקט והנחיות לציבור.`,
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
