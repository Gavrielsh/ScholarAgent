// RAGAS evaluation interface — targets from the thesis proposal (§8):
//   Context Precision  > 80%
//   Context Recall     > 75%   ← previously missing
//   Faithfulness       > 90%
//   Answer Relevancy   > 85%
//   Data Leakage Score   0%   (measured separately via lib/metrics/dls.ts)
//   Latency            < 3 s
//   Execution Cost     comparative (cost per query, Gemini vs Llama)

export interface RagasInput {
  question: string;
  answer: string;
  contexts: string[];    // retrieved chunks used to generate the answer
  groundTruth?: string;  // reference answer (required for Recall)
}

export interface RagasScores {
  contextPrecision: number;  // 0–1: fraction of retrieved chunks that are relevant
  contextRecall: number;     // 0–1: fraction of relevant chunks that were retrieved
  faithfulness: number;      // 0–1: answer grounded in context (no hallucination)
  answerRelevancy: number;   // 0–1: answer addresses the question
  latencyMs?: number;        // wall-clock time from query receipt to response
  executionCostUsd?: number; // estimated API cost in USD for this query
}

export interface RagasThresholds {
  contextPrecision: number;
  contextRecall: number;
  faithfulness: number;
  answerRelevancy: number;
  latencyMs: number;
}

export const RAGAS_TARGETS: RagasThresholds = {
  contextPrecision: 0.80,
  contextRecall:    0.75,
  faithfulness:     0.90,
  answerRelevancy:  0.85,
  latencyMs:        3000,
};

// Returns true when every scored metric meets the thesis threshold.
export function meetsTargets(scores: RagasScores): boolean {
  return (
    scores.contextPrecision >= RAGAS_TARGETS.contextPrecision &&
    scores.contextRecall    >= RAGAS_TARGETS.contextRecall    &&
    scores.faithfulness     >= RAGAS_TARGETS.faithfulness     &&
    scores.answerRelevancy  >= RAGAS_TARGETS.answerRelevancy  &&
    (scores.latencyMs === undefined || scores.latencyMs <= RAGAS_TARGETS.latencyMs)
  );
}

// Produces a human-readable gap report for logging and the academic report.
export function scoreReport(scores: RagasScores): Record<string, string> {
  const fmt = (v: number, t: number) =>
    `${(v * 100).toFixed(1)}% (target: ${(t * 100).toFixed(0)}%, ${v >= t ? "✓" : "✗"})`;

  return {
    contextPrecision: fmt(scores.contextPrecision, RAGAS_TARGETS.contextPrecision),
    contextRecall:    fmt(scores.contextRecall,    RAGAS_TARGETS.contextRecall),
    faithfulness:     fmt(scores.faithfulness,     RAGAS_TARGETS.faithfulness),
    answerRelevancy:  fmt(scores.answerRelevancy,  RAGAS_TARGETS.answerRelevancy),
    latency: scores.latencyMs !== undefined
      ? `${scores.latencyMs} ms (target: <${RAGAS_TARGETS.latencyMs} ms, ${scores.latencyMs <= RAGAS_TARGETS.latencyMs ? "✓" : "✗"})`
      : "not measured",
    executionCost: scores.executionCostUsd !== undefined
      ? `$${scores.executionCostUsd.toFixed(6)}`
      : "not measured",
  };
}

// TODO: Replace with real RAGAS evaluation calls.
// Options:
//   A) Python sidecar: spin up a FastAPI process running `ragas` and call it via fetch.
//   B) ragas-js (if a stable JS port exists by evaluation time).
//   C) LLM-as-judge: prompt Gemini/GPT-4o to score each metric.
// Wire this up in Phase 5 (May 2026) of the project timeline.
export async function evaluateRagas(_input: RagasInput): Promise<RagasScores> {
  throw new Error(
    "RAGAS evaluation not yet implemented. " +
    "See the TODO in lib/metrics/ragas.ts for integration options."
  );
}
