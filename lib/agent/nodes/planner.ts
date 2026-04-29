import type { AgentGraphState, PlanStep } from "@/lib/agent/state";

function createPlanFromMission(mission: string): PlanStep[] {
  const normalized = mission.trim();

  if (!normalized) {
    return [
      {
        id: "step-1",
        description: "Clarify missing user mission and ask a focused follow-up.",
        status: "pending",
      },
    ];
  }

  return [
    {
      id: "step-1",
      description: `Collect real-time web evidence related to: "${normalized}"`,
      status: "pending",
    },
    {
      id: "step-2",
      description: `Retrieve internal educational context from vector store for: "${normalized}"`,
      status: "pending",
    },
    {
      id: "step-3",
      description: "Synthesize findings into an actionable, concise WhatsApp response.",
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

  const plan = createPlanFromMission(state.mission);
  return {
    plan,
    current_step_index: 0,
  };
}
