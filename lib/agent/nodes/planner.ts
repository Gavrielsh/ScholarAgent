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

// Fallback plan used when the LLM returns unparseable output.
function heuristicPlan(mission: string): PlanStep[] {
  const normalized = mission.trim();
  if (!normalized) {
    return [
      { id: "step-1", description: "בקשת הבהרה מהמשתמש לגבי מטרת הפניה.", tool: "synthesize", status: "pending" },
    ];
  }
  return [
    { id: "step-1", description: "איסוף מידע רלוונטי ממאגר הידע הפנימי.", tool: "pgvector",   status: "pending" },
    { id: "step-2", description: "איסוף מקורות חיצוניים עדכניים לפי הצורך.",  tool: "tavily",    status: "pending" },
    { id: "step-3", description: "ניסוח תשובה מותאמת תפקיד וברורה לוואטסאפ.", tool: "synthesize", status: "pending" },
  ];
}

interface RawStep {
  id?: unknown;
  description?: unknown;
  tool?: unknown;
}

const VALID_TOOLS: ReadonlySet<string> = new Set(["tavily", "pgvector", "both", "synthesize"]);

function parseLlmPlan(raw: string, mission: string): PlanStep[] {
  // Strip any accidental markdown fences the LLM might have added.
  const cleaned = raw.replace(/```[a-z]*\n?/gi, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return heuristicPlan(mission);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return heuristicPlan(mission);
  }

  const steps: PlanStep[] = [];
  for (const item of parsed as RawStep[]) {
    if (typeof item.id !== "string" || typeof item.description !== "string") {
      continue;
    }
    const tool: PlanStepTool = VALID_TOOLS.has(String(item.tool))
      ? (item.tool as PlanStepTool)
      : "pgvector";

    steps.push({ id: item.id, description: item.description, tool, status: "pending" });
  }

  return steps.length > 0 ? steps : heuristicPlan(mission);
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
    });
    plan = parseLlmPlan(raw, state.mission);
  } catch {
    // LLM unavailable (e.g. missing API key) — degrade gracefully.
    plan = heuristicPlan(state.mission);
  }

  return { plan, current_step_index: 0 };
}
