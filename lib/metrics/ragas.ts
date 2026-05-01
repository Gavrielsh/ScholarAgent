// RAGAS evaluation stubs — targets from the thesis proposal:
//   Context Precision  > 80%
//   Faithfulness       > 90%
//   Answer Relevancy   > 85%
//   Latency            < 3 seconds

export interface RagasInput {
  question: string;
  answer: string;
  contexts: string[];   // retrieved chunks used to generate the answer
  groundTruth?: string; // reference answer (optional for some metrics)
}

export interface RagasScores {
  contextPrecision: number;   // 0–1
  faithfulness: number;       // 0–1
  answerRelevancy: number;    // 0–1
  latencyMs?: number;
}

export interface RagasThresholds {
  contextPrecision: number;
  faithfulness: number;
  answerRelevancy: number;
  latencyMs: number;
}

export const RAGAS_TARGETS: RagasThresholds = {
  contextPrecision: 0.80,
  faithfulness: 0.90,
  answerRelevancy: 0.85,
  latencyMs: 3000,
};

// Checks whether all scores meet the thesis targets.
export function meetsTargets(scores: RagasScores): boolean {
  return (
    scores.contextPrecision >= RAGAS_TARGETS.contextPrecision &&
    scores.faithfulness >= RAGAS_TARGETS.faithfulness &&
    scores.answerRelevancy >= RAGAS_TARGETS.answerRelevancy &&
    (scores.latencyMs === undefined || scores.latencyMs <= RAGAS_TARGETS.latencyMs)
  );
}

// TODO: Replace stubs with real RAGAS API calls (Python sidecar or ragas-js) once
//       the evaluation pipeline is wired up in Phase 3 (May–June 2026).
export async function evaluateRagas(_input: RagasInput): Promise<RagasScores> {
  throw new Error("RAGAS evaluation not yet implemented. Wire up the evaluation pipeline first.");
}
