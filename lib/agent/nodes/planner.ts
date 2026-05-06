import type { AgentGraphState, PlanStep } from "@/lib/agent/state";
import { getLlmAdapter } from "@/lib/llm/adapter";

function fallbackPlan(mission: string): PlanStep[] {
  const hasMission = mission.trim().length > 0;
  return [
    {
      id: "step-1",
      description: hasMission
        ? "איסוף מידע רלוונטי ממאגר הידע הפנימי."
        : "בקשת הבהרה מהמשתמש לגבי מטרת הפניה.",
      status: "pending",
    },
    {
      id: "step-2",
      description: "איסוף מקורות חיצוניים עדכניים לפי הצורך.",
      status: "pending",
    },
    {
      id: "step-3",
      description: "ניסוח תשובה מותאמת תפקיד וברורה לוואטסאפ.",
      status: "pending",
    },
  ];
}

export async function plannerNode(
  state: AgentGraphState
): Promise<Partial<AgentGraphState>> {
  if (state.plan.length > 0) {
    return {};
  }
  const adapter = getLlmAdapter();
  let plan: PlanStep[] = fallbackPlan(state.mission);
  try {
    const output = await adapter.generateText({
      messages: [
        {
          role: "system",
          content:
            "אתה מתכנן של Agentic-RAG. החזר JSON בלבד במבנה {\"steps\":[{\"description\":\"...\"}]}. כתוב 2-4 שלבים פרקטיים בעברית, ללא שלב שאינו בר ביצוע.",
        },
        {
          role: "user",
          content: `משימה: ${state.mission || "לא נמסרה משימה"}\nהקשר משתמש: ${state.user_context?.roleName ?? "לא ידוע"} (L${state.user_context?.permissionLevel ?? 4})`,
        },
      ],
      temperature: 0.1,
    });
    const parsed = JSON.parse(output) as { steps?: Array<{ description?: string }> };
    const steps = (parsed.steps ?? [])
      .map((s) => s.description?.trim())
      .filter((s): s is string => Boolean(s));
    if (steps.length > 0) {
      plan = steps.map((description, index) => ({
        id: `step-${index + 1}`,
        description,
        status: "pending",
      }));
    }
  } catch {
    plan = fallbackPlan(state.mission);
  }
  return {
    plan,
    current_step_index: 0,
  };
}
