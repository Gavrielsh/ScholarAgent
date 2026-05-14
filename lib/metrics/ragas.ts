// RAGAS-style evaluation — baseline metrics for comparative testing (thesis §8).
// Uses an LLM-as-judge when LLM_PROVIDER is configured; otherwise heuristic fallbacks.

import { getLlmAdapter } from "@/lib/llm/adapter";

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

export interface RagasThresholds {
  contextPrecision: number;
  contextRecall: number;
  faithfulness: number;
  answerRelevancy: number;
  latencyMs: number;
}

export const RAGAS_TARGETS: RagasThresholds = {
  contextPrecision: 0.8,
  contextRecall: 0.75,
  faithfulness: 0.9,
  answerRelevancy: 0.85,
  latencyMs: 3000,
};

export function meetsTargets(scores: RagasScores): boolean {
  return (
    scores.contextPrecision >= RAGAS_TARGETS.contextPrecision &&
    scores.contextRecall >= RAGAS_TARGETS.contextRecall &&
    scores.faithfulness >= RAGAS_TARGETS.faithfulness &&
    scores.answerRelevancy >= RAGAS_TARGETS.answerRelevancy &&
    (scores.latencyMs === undefined || scores.latencyMs <= RAGAS_TARGETS.latencyMs)
  );
}

export function scoreReport(scores: RagasScores): Record<string, string> {
  const fmt = (v: number, t: number) =>
    `${(v * 100).toFixed(1)}% (target: ${(t * 100).toFixed(0)}%, ${v >= t ? "✓" : "✗"})`;

  return {
    contextPrecision: fmt(scores.contextPrecision, RAGAS_TARGETS.contextPrecision),
    contextRecall: fmt(scores.contextRecall, RAGAS_TARGETS.contextRecall),
    faithfulness: fmt(scores.faithfulness, RAGAS_TARGETS.faithfulness),
    answerRelevancy: fmt(scores.answerRelevancy, RAGAS_TARGETS.answerRelevancy),
    latency:
      scores.latencyMs !== undefined
        ? `${scores.latencyMs} ms (target: <${RAGAS_TARGETS.latencyMs} ms, ${scores.latencyMs <= RAGAS_TARGETS.latencyMs ? "✓" : "✗"})`
        : "not measured",
    executionCost:
      scores.executionCostUsd !== undefined ? `$${scores.executionCostUsd.toFixed(6)}` : "not measured",
  };
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

export interface GoldenRunResult {
  recordId: string;
  ragas: RagasScores;
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
export async function evaluateRagas(input: RagasInput): Promise<RagasScores> {
  const started = Date.now();
  const provider = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();

  if (provider === "mock") {
    return { ...heuristicScores(input), latencyMs: Date.now() - started };
  }

  const adapter = getLlmAdapter();
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

/**
 * Runs `evaluateRagas` across a golden dataset after you supply an answer+contexts builder.
 * Intended for offline scripts / CI (not hot-path WhatsApp traffic).
 */
export async function evaluateGoldenDataset(
  records: GoldenDatasetRecord[],
  runner: (row: GoldenDatasetRecord) => Promise<{ answer: string; contexts: string[] }>
): Promise<GoldenRunResult[]> {
  const out: GoldenRunResult[] = [];
  for (const row of records) {
    const { answer, contexts } = await runner(row);
    const ragas = await evaluateRagas({
      question: row.question,
      answer,
      contexts,
      groundTruth: row.groundTruthAnswer,
    });
    out.push({ recordId: row.id, ragas });
  }
  return out;
}
