import { END, START, StateGraph } from "@langchain/langgraph";

import type { AgentGraphState } from "@/lib/agent/state";
import { plannerNode } from "@/lib/agent/nodes/planner";
import { researcherNode } from "@/lib/agent/nodes/researcher";
import { responderNode } from "@/lib/agent/nodes/responder";

const graph = new StateGraph<AgentGraphState>({
  channels: {
    messages: {
      value: (x: AgentGraphState["messages"], y: AgentGraphState["messages"]) => y ?? x,
      default: () => [],
    },
    mission: {
      value: (x: string, y: string) => y ?? x,
      default: () => "",
    },
    plan: {
      value: (x: AgentGraphState["plan"], y: AgentGraphState["plan"]) => y ?? x,
      default: () => [],
    },
    gathered_context: {
      value: (x: AgentGraphState["gathered_context"], y: AgentGraphState["gathered_context"]) => y ?? x,
      default: () => [],
    },
    current_step_index: {
      value: (x: number, y: number) => y ?? x,
      default: () => 0,
    },
    final_response: {
      value: (x: string | undefined, y: string | undefined) => y ?? x,
      default: () => undefined,
    },
  },
})
  .addNode("planner", plannerNode)
  .addNode("researcher", researcherNode)
  .addNode("responder", responderNode)
  .addEdge(START, "planner")
  .addEdge("planner", "researcher")
  .addConditionalEdges("researcher", (state) => {
    const planCompleted = state.current_step_index >= state.plan.length;
    return planCompleted ? "responder" : "researcher";
  })
  .addEdge("responder", END);

export const agentGraphApp = graph.compile();

export async function runAgentWorkflow(input: {
  mission: string;
  senderId?: string;
  incomingMessage?: string;
}) {
  const now = new Date().toISOString();

  return agentGraphApp.invoke({
    messages: [
      {
        role: "system",
        content: input.senderId
          ? `Incoming WhatsApp sender: ${input.senderId}`
          : "Incoming WhatsApp sender unknown.",
        createdAt: now,
      },
      {
        role: "user",
        content: input.incomingMessage ?? input.mission,
        createdAt: now,
      },
    ],
    mission: input.mission,
    plan: [],
    gathered_context: [],
    current_step_index: 0,
    final_response: undefined,
  } satisfies AgentGraphState);
}
