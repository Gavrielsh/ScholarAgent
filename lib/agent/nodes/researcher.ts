import type { AgentGraphState, PlanStep, RetrievedContext } from "@/lib/agent/state";
import { querySimilarDocuments } from "@/lib/db/pgvector";
import { getLlmAdapter } from "@/lib/llm/adapter";
import { tavilySearch } from "@/lib/tools/tavily";

function markStepStatus(steps: PlanStep[], index: number, status: PlanStep["status"]): PlanStep[] {
  return steps.map((step, i) => (i === index ? { ...step, status } : step));
}

export async function researcherNode(
  state: AgentGraphState
): Promise<Partial<AgentGraphState>> {
  if (state.current_step_index >= state.plan.length) {
    return {};
  }

  const activeStep = state.plan[state.current_step_index];
  const inProgressPlan = markStepStatus(state.plan, state.current_step_index, "in_progress");
  const adapter = getLlmAdapter();

  const newContext: RetrievedContext[] = [];

  try {
    const routingRaw = await adapter.generateText({
      messages: [
        {
          role: "system",
          content:
            "בחר כלים לשלב מחקר והחזר JSON בלבד: {\"tools\":[{\"name\":\"pgvector|tavily\",\"query\":\"...\"}]}.",
        },
        {
          role: "user",
          content: `משימה: ${state.mission}\nשלב פעיל: ${activeStep.description}`,
        },
      ],
      temperature: 0,
    });
    const routing = JSON.parse(routingRaw) as {
      tools?: Array<{ name?: "pgvector" | "tavily"; query?: string }>;
    };
    const selectedTools = (routing.tools ?? []).length
      ? (routing.tools ?? [])
      : [{ name: "pgvector" as const, query: state.mission }];
    const permissionLevel = state.user_context?.permissionLevel ?? 4;

    for (const tool of selectedTools) {
      const query = tool.query?.trim() || state.mission;
      if (tool.name === "pgvector") {
        const docs = await querySimilarDocuments(query, permissionLevel, 5);
        newContext.push(
          ...docs.map((doc) => ({
            source: "pgvector" as const,
            content: doc.text,
            metadata: {
              similarity: doc.similarity,
              classification_level: doc.classificationLevel,
              ...doc.metadata,
            },
          }))
        );
      }
      if (tool.name === "tavily") {
        const web = await tavilySearch(query);
        newContext.push(
          ...web.results.map((item) => ({
            source: "tavily" as const,
            content: `${item.title}\n${item.content}\n${item.url}`,
            metadata: { url: item.url, score: item.score },
          }))
        );
      }
    }

    const completedPlan = markStepStatus(inProgressPlan, state.current_step_index, "completed");

    return {
      plan: completedPlan,
      gathered_context: [...state.gathered_context, ...newContext],
      current_step_index: state.current_step_index + 1,
    };
  } catch (error) {
    const failedPlan = markStepStatus(inProgressPlan, state.current_step_index, "failed");
    return {
      plan: failedPlan,
      gathered_context: [
        ...state.gathered_context,
        {
          source: "tavily",
          content: "שלב המחקר נכשל. ממשיכים עם הקשר חלקי.",
          metadata: {
            error: error instanceof Error ? error.message : "Unknown researcher error",
            failed_step: activeStep.id,
          },
        },
      ],
      current_step_index: state.current_step_index + 1,
    };
  }
}
