// RAGAS-style evaluation — baseline metrics for comparative testing (thesis §8).
// Uses an LLM-as-judge when LLM_PROVIDER is configured; otherwise heuristic fallbacks.

/** The one message shape the judge prompt is built from. */
export interface RagasJudgeMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The single LLM capability RAGAS needs. The chat domain's adapter satisfies it. */
export interface RagasJudge {
  generateText(input: {
    messages: RagasJudgeMessage[];
    temperature?: number;
    responseSchema?: Record<string, unknown>;
  }): Promise<string>;
}

/**
 * Resolves the judge only when one is actually needed.
 *
 * Injected rather than imported so this module stays free of provider wiring;
 * a factory rather than an instance so the heuristic path never constructs an
 * adapter it will not call.
 */
export type RagasJudgeFactory = () => RagasJudge;

export interface RagasInput {
  question: string;
  answer: string;
  contexts: string[];
  groundTruth?: string;
}

export interface RagasScores {
  contextPrecision: number;
  contextRecall: number;
  faithfulness: number;
  answerRelevancy: number;
  latencyMs?: number;
  executionCostUsd?: number;
}

/** Single labelled example in a golden dataset (offline eval). */
export interface GoldenDatasetRecord {
  id: string;
  question: string;
  /** Authoritative reference answer for recall-oriented checks. */
  groundTruthAnswer: string;
  /** Optional: substring hints expected to appear in retrieved contexts. */
  expectedContextHints?: string[];
}

function parseJudgeJson(raw: string): Partial<RagasScores> | null {
  const trimmed = raw.trim();
  const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  try {
    return JSON.parse(jsonText) as Partial<RagasScores>;
  } catch {
    return null;
  }
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Lexical fallbacks when no judge LLM is available (conservative lower bounds). */
function heuristicScores(input: RagasInput): RagasScores {
  const ans = input.answer.trim();
  const ctx = input.contexts;
  const gt = (input.groundTruth ?? "").trim();

  const contextPrecision =
    ctx.length === 0 ? 0 : ctx.filter((c) => c && c.trim().length > 40).length / ctx.length;

  const faithfulness =
    ctx.length === 0
      ? 0.15
      : ctx.some(
          (c) => ans.length > 20 && c.toLowerCase().includes(ans.slice(0, Math.min(40, ans.length)).toLowerCase())
        )
        ? 0.55
        : 0.3;

  const words = gt ? gt.split(/\s+/).filter((w) => w.length > 4) : [];
  const answerRelevancy =
    words.length === 0 ? (ans.length > 12 ? 0.4 : 0.15) : words.filter((w) => ans.toLowerCase().includes(w.toLowerCase())).length / words.length;

  const contextRecall =
    words.length === 0
      ? 0.5
      : words.filter((w) => ctx.some((c) => c.toLowerCase().includes(w.toLowerCase()))).length / words.length;

  return {
    contextPrecision: clamp01(contextPrecision),
    contextRecall: clamp01(contextRecall),
    faithfulness: clamp01(faithfulness),
    answerRelevancy: clamp01(answerRelevancy),
  };
}

/**
 * Scores a single RAG tuple. Prefer wiring a Python RAGAS worker in CI for publication-grade numbers;
 * this path provides repeatable baseline instrumentation inside the TypeScript repo.
 */
export async function evaluateRagas(
  input: RagasInput,
  judgeFactory: RagasJudgeFactory
): Promise<RagasScores> {
  const started = Date.now();
  const provider = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();

  if (provider === "mock") {
    return { ...heuristicScores(input), latencyMs: Date.now() - started };
  }

  const adapter = judgeFactory();
  const contextBlock = input.contexts.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");

  const judgePrompt = `You are an evaluation judge for a Hebrew educational RAG system.
Score each metric from 0 to 1 (float). Return ONLY JSON with keys:
contextPrecision (fraction of retrieved chunks that help answer the question),
contextRecall (how well contexts cover facts needed vs groundTruth, omit ground-truth checks if groundTruth empty — then use 0.5),
faithfulness (answer stays grounded in contexts, no contradictions),
answerRelevancy (answer addresses the question).

Question: ${input.question}
Answer: ${input.answer}
Contexts:
${contextBlock}
Ground truth (may be empty): ${input.groundTruth ?? ""}`;

  try {
    const raw = await adapter.generateText({
      temperature: 0,
      messages: [
        { role: "system", content: "Return compact JSON only. Keys: contextPrecision, contextRecall, faithfulness, answerRelevancy (numbers 0-1)." },
        { role: "user", content: judgePrompt },
      ],
      responseSchema: {
        type: "object",
        properties: {
          contextPrecision: { type: "number" },
          contextRecall: { type: "number" },
          faithfulness: { type: "number" },
          answerRelevancy: { type: "number" },
        },
        required: ["contextPrecision", "contextRecall", "faithfulness", "answerRelevancy"],
      },
    });

    const parsed = parseJudgeJson(raw);
    if (!parsed) {
      return { ...heuristicScores(input), latencyMs: Date.now() - started };
    }

    return {
      contextPrecision: clamp01(parsed.contextPrecision),
      contextRecall: clamp01(parsed.contextRecall),
      faithfulness: clamp01(parsed.faithfulness),
      answerRelevancy: clamp01(parsed.answerRelevancy),
      latencyMs: Date.now() - started,
    };
  } catch {
    return { ...heuristicScores(input), latencyMs: Date.now() - started };
  }
}
