import { END, START, StateGraph } from "@langchain/langgraph";

import type { AgentGraphState, ChatMessage, UserContext } from "@/lib/agent/state";
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
    needs_replanning: {
      value: (x: boolean | undefined, y: boolean | undefined) => y ?? x,
      default: () => false,
    },
    replanning_count: {
      value: (x: number | undefined, y: number | undefined) => y ?? x,
      default: () => 0,
    },
    final_response: {
      value: (x: string | undefined, y: string | undefined) => y ?? x,
      default: () => undefined,
    },
    user_context: {
      value: (x: AgentGraphState["user_context"], y: AgentGraphState["user_context"]) => y ?? x,
      default: () => undefined,
    },
  },
})
  .addNode("planner", plannerNode)
  .addNode("researcher", researcherNode)
  .addNode("replanner", async (state) => {
    return {
      needs_replanning: false,
      replanning_count: (state.replanning_count ?? 0) + 1,
      plan: [],
      current_step_index: 0,
      messages: [
        ...state.messages,
        {
          role: "system" as const,
          content:
            "Previous search yielded no results. Formulate a new plan with different keywords or fallback tools.",
          createdAt: new Date().toISOString(),
        },
      ],
    };
  })
  .addNode("responder", responderNode)
  .addEdge(START, "planner")
  .addEdge("planner", "researcher")
  .addConditionalEdges("researcher", (state) => {
    if (state.needs_replanning && (state.replanning_count ?? 0) < 1) {
      return "replanner";
    }
    const planCompleted = state.current_step_index >= state.plan.length;
    return planCompleted ? "responder" : "researcher";
  })
  .addEdge("replanner", "planner")
  .addEdge("responder", END);

export const agentGraphApp = graph.compile();

export async function runAgentWorkflow(input: {
  mission: string;
  senderId?: string;
  incomingMessage?: string;
  userContext?: UserContext;
  // Prior conversation turns loaded from chat history for multi-turn context.
  priorMessages?: ChatMessage[];
}) {
  const now = new Date().toISOString();

  const systemMessage: ChatMessage = {
    role: "system",
    content: input.senderId
      ? `Incoming WhatsApp sender: ${input.senderId}`
      : "Incoming WhatsApp sender unknown.",
    createdAt: now,
  };

  const currentMessage: ChatMessage = {
    role: "user",
    content: input.incomingMessage ?? input.mission,
    createdAt: now,
  };

  // Prepend prior turns so the responder has full conversation history,
  // supporting multi-turn follow-up questions over WhatsApp.
  const messages: ChatMessage[] = [
    systemMessage,
    ...(input.priorMessages ?? []),
    currentMessage,
  ];

  return agentGraphApp.invoke({
    messages,
    mission: input.mission,
    plan: [],
    gathered_context: [],
    current_step_index: 0,
    needs_replanning: false,
    replanning_count: 0,
    final_response: undefined,
    user_context: input.userContext,
  } satisfies AgentGraphState);
}
