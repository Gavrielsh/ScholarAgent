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

  const newContext: RetrievedContext[] = [];

  try {
    // TODO: Replace heuristic matching with a proper tool-selection policy agent.
    if (activeStep.description.toLowerCase().includes("web evidence")) {
      const web = await tavilySearch(state.mission);
      newContext.push(
        ...web.results.map((item) => ({
          source: "tavily" as const,
          content: `${item.title}\n${item.content}\n${item.url}`,
          metadata: { url: item.url, score: item.score },
        }))
      );
    }

    if (activeStep.description.toLowerCase().includes("vector store")) {
      const docs = await querySimilarDocuments(state.mission, 5);
      newContext.push(
        ...docs.map((doc) => ({
          source: "pgvector" as const,
          content: doc.text,
          metadata: {
            similarity: doc.similarity,
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
    };
  } catch (error) {
    const failedPlan = markStepStatus(inProgressPlan, state.current_step_index, "failed");
    return {
      plan: failedPlan,
      gathered_context: [
        ...state.gathered_context,
        {
          source: "tavily",
          content: "Research step failed. Falling back to partial context.",
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
