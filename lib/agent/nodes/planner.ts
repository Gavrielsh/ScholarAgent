import type { AgentGraphState, PlanStep, PlanStepTool } from "@/lib/agent/state";
import { getLlmAdapter } from "@/lib/llm/adapter";

// Prompt instructs the LLM to return a JSON array of plan steps.
// Each step declares which tool the researcher should call, making the
// flow deterministic while still being query-aware (H1 of the proposal).
const PLANNER_SYSTEM_PROMPT = `You are a planning agent for an educational knowledge-management system.
Given a user query (mission), output a JSON array of research steps — nothing else.

Each step must have these fields:
  "id":          string (step-1, step-2, …)
  "description": string (short action description)
  "tool":        one of "tavily" | "pgvector" | "both" | "synthesize"

Tool selection rules:
- "tavily"    — current events, news, external web information
- "pgvector"  — organisation-internal documents, protocols, lesson plans
- "both"      — the query needs both web and internal sources
- "synthesize"— final step: combine gathered evidence into a response

Output ONLY the JSON array. No markdown fences, no explanation.

Example output:
[
  {"id":"step-1","description":"Search web for recent updates","tool":"tavily"},
  {"id":"step-2","description":"Retrieve internal protocols","tool":"pgvector"},
  {"id":"step-3","description":"Synthesize findings","tool":"synthesize"}
]`;

const PLAN_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "description", "tool"],
    properties: {
      id: { type: "string" },
      description: { type: "string" },
      tool: { type: "string", enum: ["tavily", "pgvector", "both", "synthesize"] },
    },
  },
} as const;

interface RawStep {
  id: string;
  description: string;
  tool: PlanStepTool;
}

export async function plannerNode(
  state: AgentGraphState
): Promise<Partial<AgentGraphState>> {
  if (state.plan.length > 0) {
    return {};
  }

  const adapter = getLlmAdapter();
  let plan: PlanStep[];

  try {
    const raw = await adapter.generateText({
      messages: [
        { role: "system", content: PLANNER_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Mission: ${state.mission || "No mission provided."}\nUser level: L${state.user_context?.permissionLevel ?? 4}`,
        },
      ],
      temperature: 0.0, // deterministic plan generation
      responseSchema: PLAN_SCHEMA as unknown as Record<string, any>,
    });
    const parsed = JSON.parse(raw) as RawStep[];
    plan = parsed.map((item) => ({
      id: item.id,
      description: item.description,
      tool: item.tool,
      status: "pending",
    }));
  } catch {
    // LLM unavailable — minimal safe fallback.
    plan = [
      {
        id: "step-1",
        description: "איסוף מידע פנימי ממאגר הידע.",
        tool: "pgvector",
        status: "pending",
      },
      {
        id: "step-2",
        description: "גיבוש תשובה תמציתית למשתמש.",
        tool: "synthesize",
        status: "pending",
      },
    ];
  }

  return { plan, current_step_index: 0, needs_replanning: false };
}
