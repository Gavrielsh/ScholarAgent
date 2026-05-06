import type { AgentGraphState, PlanStep, RetrievedContext } from "@/lib/agent/state";
import { querySimilarDocuments } from "@/lib/db/pgvector";
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
  const useTavily = activeStep.tool === "tavily" || activeStep.tool === "both";
  const useVector = activeStep.tool === "pgvector" || activeStep.tool === "both";

  const newContext: RetrievedContext[] = [];
  let vectorDocsCount = 0;

  try {
    if (useTavily) {
      const web = await tavilySearch(state.mission);
      newContext.push(
        ...web.results.map((item) => ({
          source: "tavily" as const,
          content: `${item.title}\n${item.content}\n${item.url}`,
          metadata: { url: item.url, score: item.score },
        }))
      );
    }

    if (useVector) {
      // RLS requires a permission level. Default to Guest (L4) when no user
      // context is present — never broaden access silently.
      const permissionLevel = state.user_context?.permissionLevel ?? 4;
      const docs = await querySimilarDocuments(state.mission, permissionLevel, 5);
      vectorDocsCount = docs.length;
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

    const completedPlan = markStepStatus(inProgressPlan, state.current_step_index, "completed");

    return {
      plan: completedPlan,
      gathered_context: [...state.gathered_context, ...newContext],
      current_step_index: state.current_step_index + 1,
      needs_replanning: useVector && vectorDocsCount === 0,
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
