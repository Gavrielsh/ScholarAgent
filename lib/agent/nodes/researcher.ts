import type { AgentGraphState, PlanStep, RetrievedContext } from "@/lib/agent/state";
import { querySimilarDocuments } from "@/lib/db/pgvector";
import { tavilySearch } from "@/lib/tools/tavily";

function markStepStatus(steps: PlanStep[], index: number, status: PlanStep["status"]): PlanStep[] {
  return steps.map((step, i) => (i === index ? { ...step, status } : step));
}

// Determines which tools to run for a step.
// Primary decision: the `tool` field set by the LLM planner.
// Fallback: legacy keyword heuristic for steps that predate the tool field.
function resolveTool(step: PlanStep): { useTavily: boolean; useVector: boolean } {
  if (step.tool) {
    return {
      useTavily: step.tool === "tavily" || step.tool === "both",
      useVector: step.tool === "pgvector" || step.tool === "both",
    };
  }

  // Legacy keyword fallback (kept for backward compatibility with old plan shapes).
  const desc = step.description.toLowerCase();
  return {
    useTavily: desc.includes("web") || desc.includes("tavily") || desc.includes("חיצוני"),
    useVector: desc.includes("vector") || desc.includes("internal") || desc.includes("פנימי") || desc.includes("מאגר"),
  };
}

export async function researcherNode(
  state: AgentGraphState
): Promise<Partial<AgentGraphState>> {
  if (state.current_step_index >= state.plan.length) {
    return {};
  }

  const activeStep = state.plan[state.current_step_index];
  const inProgressPlan = markStepStatus(state.plan, state.current_step_index, "in_progress");
  const { useTavily, useVector } = resolveTool(activeStep);

  const newContext: RetrievedContext[] = [];

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
