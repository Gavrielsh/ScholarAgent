/**
 * irMetrics.ts — standard information-retrieval metrics, implemented from scratch.
 *
 * No external IR library. Every formula here is the textbook definition, written
 * out so the thesis can state exactly what was computed rather than cite a
 * package's defaults.
 *
 * ## The NaN convention
 *
 * A metric whose denominator is empty is **unestimable**, not zero. Recall over a
 * query with no relevant documents, or a percentile over no samples, returns
 * `NaN` and is excluded from aggregation by `meanStd`. Returning 0 instead would
 * read as "the system retrieved none of the relevant documents" when the truth is
 * "there were none to retrieve" — the same failure mode `aggregateTwoStageLeakage`
 * avoids for the containment gap, and for the same reason: a plausible-looking
 * zero is worse than an honest gap in the table.
 */

/** Graded relevance. 0 = irrelevant, 1 = partially relevant, 2 = fully relevant. */
export type RelevanceGrade = 0 | 1 | 2;

/** Per-query judgements: chunk id → grade. Absent id means grade 0. */
export type QueryJudgements = ReadonlyMap<string, RelevanceGrade>;

/** Grade > 0 counts as relevant for the binary metrics (Recall, MRR). */
function isRelevant(grade: RelevanceGrade | undefined): boolean {
  return grade !== undefined && grade > 0;
}

function countRelevant(judgements: QueryJudgements): number {
  let n = 0;
  for (const grade of judgements.values()) {
    if (isRelevant(grade)) n++;
  }
  return n;
}

/**
 * Recall@k — of all relevant chunks that exist, the share appearing in the top k.
 *
 * Returns NaN when the query has no relevant chunks at all: the denominator is
 * zero and no score is defined. Note this is recall over the *judged* relevant
 * set, so it is bounded by pooling depth — a relevant chunk no arm ever retrieved
 * was never annotated and so cannot be counted as missed. State that limitation
 * alongside the number.
 */
export function recallAtK(
  retrievedIds: readonly string[],
  judgements: QueryJudgements,
  k: number
): number {
  const total = countRelevant(judgements);
  if (total === 0) return NaN;

  const topK = retrievedIds.slice(0, k);
  const seen = new Set<string>();
  let hits = 0;
  for (const id of topK) {
    if (seen.has(id)) continue; // a duplicated id must not count twice
    seen.add(id);
    if (isRelevant(judgements.get(id))) hits++;
  }
  return hits / total;
}

/**
 * Reciprocal rank — 1 / (rank of the first relevant chunk), 1-indexed.
 *
 * Zero when nothing relevant was retrieved, which is a real score: the system
 * had relevant material available and surfaced none of it. NaN only when the
 * query has no relevant chunks to find.
 */
export function reciprocalRank(
  retrievedIds: readonly string[],
  judgements: QueryJudgements
): number {
  if (countRelevant(judgements) === 0) return NaN;

  for (let i = 0; i < retrievedIds.length; i++) {
    if (isRelevant(judgements.get(retrievedIds[i]))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Gain for a grade under the standard exponential formulation. */
function gain(grade: RelevanceGrade | undefined): number {
  return grade === undefined ? 0 : Math.pow(2, grade) - 1;
}

/**
 * NDCG@k with exponential gain and log2 discount:
 *
 *   DCG@k  = Σ (2^grade_i − 1) / log2(i + 1)     for i = 1..k
 *   IDCG@k = the same over grades sorted descending
 *   NDCG@k = DCG@k / IDCG@k
 *
 * This is the formulation that needs *graded* judgements to mean anything. With
 * purely binary grades NDCG collapses toward a rank-weighted recall and carries
 * little information MRR does not already give — so if the qrels are binary, say
 * so rather than presenting NDCG as an independent signal.
 */
export function ndcgAtK(
  retrievedIds: readonly string[],
  judgements: QueryJudgements,
  k: number
): number {
  const idealGrades = [...judgements.values()]
    .filter((g) => g > 0)
    .sort((a, b) => b - a);

  if (idealGrades.length === 0) return NaN;

  const discount = (rank1Indexed: number) => Math.log2(rank1Indexed + 1);

  let dcg = 0;
  const seen = new Set<string>();
  retrievedIds.slice(0, k).forEach((id, i) => {
    if (seen.has(id)) return;
    seen.add(id);
    dcg += gain(judgements.get(id)) / discount(i + 1);
  });

  let idcg = 0;
  idealGrades.slice(0, k).forEach((grade, i) => {
    idcg += (Math.pow(2, grade) - 1) / discount(i + 1);
  });

  // idcg > 0 is guaranteed: idealGrades is non-empty and every entry is > 0.
  return dcg / idcg;
}

/**
 * Percentile by the nearest-rank method on the sorted sample.
 *
 * index = ceil(p/100 × n) − 1, clamped into range. Stated explicitly because
 * percentile definitions differ (nearest-rank, linear interpolation, exclusive)
 * and a P95 latency is not comparable across two papers that chose differently.
 * No interpolation is used, so every reported value is an observed measurement
 * rather than a synthetic one.
 */
export function percentile(values: readonly number[], p: number): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return NaN;

  const sorted = [...finite].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx];
}

export interface MeanStd {
  mean: number;
  /** Population standard deviation (divides by n, not n−1). */
  std: number;
  /** Samples that contributed — NaN entries are excluded, not counted as 0. */
  n: number;
}

/**
 * Mean and population standard deviation over the finite samples only.
 *
 * Divides by n rather than n−1: these are repeated measurements of one fixed
 * configuration, not a sample drawn from a wider population, so the population
 * form is the right one and does not inflate the spread at small n.
 *
 * A single sample yields std = 0 legitimately. Beware reading that as stability:
 * deterministic retrieval over a fixed corpus returns identical rankings on
 * every repeat, so std = 0 on a quality metric means the arm is deterministic,
 * not that it is reliable. Only latency and LLM-dependent stages vary.
 */
export function meanStd(values: readonly number[]): MeanStd {
  const finite = values.filter((v) => Number.isFinite(v));
  const n = finite.length;
  if (n === 0) return { mean: NaN, std: NaN, n: 0 };

  const mean = finite.reduce((a, b) => a + b, 0) / n;
  const variance = finite.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance), n };
}

/**
 * Adaptive relevance cut at μ − α·σ over a set of fusion scores.
 *
 * SCALE HAZARD — pass RRF scores, never the `similarity` column. That column
 * holds `1 − cosine` for rows that came from the dense leg and `ts_rank_cd` for
 * rows that came from the lexical leg; the two are not on a common scale, so a
 * single threshold over them means different things for different rows. The same
 * hazard is documented in migrations/002_knowledge_gaps.sql and in
 * knowledgeGaps.maxSimilarity().
 *
 * Returns the threshold, or NaN for fewer than two scores (σ is undefined for
 * one sample, and a cut computed from a single point would discard or keep
 * everything on no evidence).
 */
export function adaptiveThreshold(scores: readonly number[], alpha: number): number {
  const finite = scores.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return NaN;
  const { mean, std } = meanStd(finite);
  return mean - alpha * std;
}
