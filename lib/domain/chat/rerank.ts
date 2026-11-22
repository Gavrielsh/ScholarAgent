/**
 * rerank.ts — stage-2 relevance re-ranking and adaptive cut for retrieval arm R4.
 *
 * ## No cross-encoder is available
 *
 * A true cross-encoder (a BERT-family model scoring query–document pairs jointly)
 * would need a local model and inference runtime that this project does not have.
 * This module instead uses the configured LLM as a pointwise relevance judge,
 * scoring every candidate in one call. That is a weaker instrument and the thesis
 * must say so:
 *
 * - **Self-preference bias.** If the same model both generates answers and ranks
 *   evidence, its rankings favour text it would itself produce. Set
 *   `RERANK_LLM_PROVIDER` to a different provider from `LLM_PROVIDER` and report
 *   both, or the measurement is contaminated.
 * - **Non-determinism.** Unlike arms R1–R3, which are deterministic SQL, R4's
 *   ordering can differ between runs. R4 is the one arm where repeated runs
 *   produce a genuine standard deviation rather than 0.
 * - **Position bias.** Candidates are presented in a fixed order and an LLM
 *   scores earlier items differently from later ones. `shuffleSeed` exists so a
 *   run can randomise presentation order and quantify this.
 */

import { z } from "zod";
import type { RagasJudge, RagasJudgeFactory } from "@/lib/core/telemetry";
import { adaptiveThreshold } from "@/lib/core/irMetrics";

export interface RerankCandidate {
  id: string;
  text: string;
  /** Fused score from stage 1. Used as the fallback ordering and fallback cut. */
  rrfScore: number;
}

export interface RerankedCandidate extends RerankCandidate {
  /** Judge score in [0, 10], or NaN when the judge produced nothing usable. */
  rerankScore: number;
}

export interface RerankOutcome {
  /** Survivors, best first, after scoring and the adaptive cut. */
  kept: RerankedCandidate[];
  /** Everything scored, best first, before the cut — for error analysis. */
  scored: RerankedCandidate[];
  /** The μ − α·σ cut actually applied, or NaN when no cut was possible. */
  threshold: number;
  /** Which score the ordering and the cut came from. */
  basis: "rerank_score" | "rrf_score";
  /**
   * True when the judge could not be used and stage 1's ordering was kept.
   * A run with this set has not measured re-ranking, and must not be reported
   * as arm R4 without saying so.
   */
  fellBack: boolean;
  fallbackReason?: string;
}

const SCORE_MIN = 0;
const SCORE_MAX = 10;

/** Deterministic PRNG so a shuffled presentation order is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildRerankPrompt(query: string, candidates: readonly RerankCandidate[]): string {
  const listed = candidates
    .map((c, i) => `### Candidate ${i + 1}\nid: ${c.id}\ntext: ${c.text.slice(0, 1200)}`)
    .join("\n\n");

  return [
    "You are scoring how well each candidate passage answers a question.",
    "",
    `Question: ${query}`,
    "",
    listed,
    "",
    `Score every candidate from ${SCORE_MIN} to ${SCORE_MAX}:`,
    `  ${SCORE_MAX} — directly and completely answers the question`,
    "  5 — related and partially useful",
    `  ${SCORE_MIN} — unrelated`,
    "",
    'Reply with JSON only: {"scores":[{"id":"<id>","score":<number>}]}',
    "Include every candidate id exactly once. No prose.",
  ].join("\n");
}

/**
 * The judge's reply envelope. `scores` is validated as a list of unknowns and
 * each entry is checked separately, because a single malformed entry must not
 * discard the whole response — see parseScores.
 */
const RerankEnvelopeSchema = z.object({
  scores: z.array(z.unknown()),
});

/**
 * One scored candidate. `refine(Number.isFinite)` is explicit rather than
 * relying on whether the installed zod major rejects NaN/Infinity by default.
 */
const RerankScoreEntrySchema = z.object({
  id: z.string(),
  score: z.number().refine((n) => Number.isFinite(n)),
});

function parseScores(raw: string): Map<string, number> | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let json: unknown;
  try {
    json = JSON.parse(match[0]);
  } catch {
    return null;
  }

  const envelope = RerankEnvelopeSchema.safeParse(json);
  if (!envelope.success) return null;

  const out = new Map<string, number>();
  for (const candidate of envelope.data.scores) {
    // Per-entry validation: one bad row is skipped, the rest still count.
    const entry = RerankScoreEntrySchema.safeParse(candidate);
    if (!entry.success) continue;
    // Clamp rather than reject: a judge returning 11 meant "maximally relevant".
    out.set(entry.data.id, Math.min(SCORE_MAX, Math.max(SCORE_MIN, entry.data.score)));
  }
  return out.size > 0 ? out : null;
}

function fallback(
  candidates: readonly RerankCandidate[],
  alpha: number,
  reason: string
): RerankOutcome {
  const scored: RerankedCandidate[] = [...candidates]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map((c) => ({ ...c, rerankScore: NaN }));

  // Cut on the fused score, never on `similarity` — that column mixes
  // 1 − cosine with ts_rank_cd and is not a single scale. See irMetrics.
  const threshold = adaptiveThreshold(scored.map((c) => c.rrfScore), alpha);
  const kept = Number.isNaN(threshold)
    ? scored
    : scored.filter((c) => c.rrfScore >= threshold);

  return {
    kept,
    scored,
    threshold,
    basis: "rrf_score",
    fellBack: true,
    fallbackReason: reason,
  };
}

export interface RerankOptions {
  query: string;
  candidates: readonly RerankCandidate[];
  /** Cut at μ − α·σ over the basis scores. Default 0.5. */
  alpha?: number;
  /** Randomise presentation order to probe position bias. Omit to keep stage-1 order. */
  shuffleSeed?: number;
}

/**
 * Scores candidates with the judge, then cuts at μ − α·σ.
 *
 * Falls back to stage-1 ordering — flagged via `fellBack` — when there is no
 * judge, the judge throws, or its output cannot be parsed. A silent fallback
 * would report arm R3's behaviour under arm R4's name.
 */
export async function rerankCandidates(
  options: RerankOptions,
  judgeFactory?: RagasJudgeFactory
): Promise<RerankOutcome> {
  const { query, candidates } = options;
  const alpha = options.alpha ?? 0.5;

  if (candidates.length === 0) {
    return {
      kept: [],
      scored: [],
      threshold: NaN,
      basis: "rrf_score",
      fellBack: false,
    };
  }

  if (!judgeFactory) {
    return fallback(candidates, alpha, "no judge configured");
  }

  const presented =
    options.shuffleSeed === undefined
      ? [...candidates]
      : shuffled(candidates, options.shuffleSeed);

  let raw: string;
  try {
    const judge: RagasJudge = judgeFactory();
    raw = await judge.generateText({
      messages: [{ role: "user", content: buildRerankPrompt(query, presented) }],
      temperature: 0,
    });
  } catch (err) {
    return fallback(candidates, alpha, err instanceof Error ? err.message : String(err));
  }

  const scores = parseScores(raw);
  if (!scores) {
    return fallback(candidates, alpha, "judge output was not parseable JSON");
  }

  // A candidate the judge omitted keeps NaN and is ordered last, rather than
  // being silently treated as a zero-relevance passage.
  const scored: RerankedCandidate[] = candidates
    .map((c) => ({ ...c, rerankScore: scores.get(c.id) ?? NaN }))
    .sort((a, b) => {
      const an = Number.isNaN(a.rerankScore);
      const bn = Number.isNaN(b.rerankScore);
      if (an && bn) return b.rrfScore - a.rrfScore;
      if (an) return 1;
      if (bn) return -1;
      return b.rerankScore - a.rerankScore;
    });

  const threshold = adaptiveThreshold(
    scored.map((c) => c.rerankScore).filter((s) => Number.isFinite(s)),
    alpha
  );

  const kept = Number.isNaN(threshold)
    ? scored.filter((c) => Number.isFinite(c.rerankScore))
    : scored.filter((c) => Number.isFinite(c.rerankScore) && c.rerankScore >= threshold);

  return {
    kept,
    scored,
    threshold,
    basis: "rerank_score",
    fellBack: false,
  };
}
