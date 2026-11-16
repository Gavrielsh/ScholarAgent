/**
 * retrievalArms.ts — the four retrieval configurations the benchmark compares.
 *
 * ## The de-confounding guarantee
 *
 * Every arm runs against the same corpus, with the same overfetch, under the
 * same RLS mechanism, through the same `executeRetrieval` in lib/core/db.ts. The
 * arms differ by exactly one thing: the retrieval strategy. That is what allows
 * a difference between arms to be attributed to the strategy.
 *
 * The query embedding is computed ONCE per query and shared by every arm. If
 * each arm embedded separately, identical arms would differ by embedding-API
 * jitter, and R1 would be charged for an embedding it never uses. Embedding
 * latency is therefore reported separately from retrieval latency, and the two
 * are not summed into a single headline number.
 *
 * Caveat worth stating in the write-up: R1 still requires an embedding to be
 * produced, because it shares the DB entry point whose signature takes a vector.
 * A production sparse-only system would not call the embedding API at all, so
 * R1's *measured* latency understates nothing but its *operational* cost in a
 * standalone deployment would be lower than the embed+retrieve total implies.
 */

import {
  querySimilarDocumentsByStrategy,
  querySimilarDocumentsByStrategyBypassRls,
  type RetrievalStrategy,
  type SimilarDocument,
} from "@/lib/core/db";
import { embedText } from "@/lib/domain/ingestion/embeddings";
import { rerankCandidates, type RerankOutcome } from "@/lib/domain/chat/rerank";
import type { RagasJudgeFactory } from "@/lib/core/telemetry";
import type { PermissionLevel } from "@/lib/security/auth";

export const ARM_IDS = ["R1_sparse", "R2_dense", "R3_hybrid_rrf", "R4_hybrid_reranked"] as const;
export type ArmId = (typeof ARM_IDS)[number];

export const ARM_LABELS: Record<ArmId, string> = {
  R1_sparse: "R1 — Sparse (PostgreSQL FTS, ts_rank_cd)",
  R2_dense: "R2 — Dense (pgvector cosine)",
  R3_hybrid_rrf: "R3 — Hybrid RRF (k=60)",
  R4_hybrid_reranked: "R4 — Hybrid RRF + re-rank + adaptive cut",
};

/** Candidates R4 fuses before re-ranking. */
export const STAGE1_LIMIT = 25;

/** Each leg's DB fetch cap, identical across arms. */
export const ARM_OVERFETCH = 200;

export const RRF_K = 60;

export interface EmbeddedQuery {
  text: string;
  vector: number[];
  embedLatencyMs: number;
}

/**
 * Embeds a query once for reuse across arms.
 *
 * Returns a null vector for a blank query or an empty embedding — neither is an
 * error, and the caller records the query as unretrievable rather than throwing.
 */
export async function embedQueryOnce(text: string): Promise<EmbeddedQuery | null> {
  if (!text.trim()) return null;
  const started = Date.now();
  const vector = await embedText(text);
  const embedLatencyMs = Date.now() - started;
  return vector.length === 0 ? null : { text, vector, embedLatencyMs };
}

export interface ArmResult {
  arm: ArmId;
  docs: SimilarDocument[];
  /** Retrieval only. Excludes embedding; for R4, excludes the re-ranking call. */
  retrievalLatencyMs: number;
  /** R4 only: time spent in the judge call and the cut. */
  rerankLatencyMs?: number;
  /** R4 only. `fellBack` true means re-ranking did not actually happen. */
  rerank?: RerankOutcome;
}

const STRATEGY_FOR_ARM: Record<ArmId, RetrievalStrategy> = {
  R1_sparse: "sparse",
  R2_dense: "dense",
  R3_hybrid_rrf: "hybrid_rrf",
  R4_hybrid_reranked: "hybrid_rrf",
};

export interface RunArmOptions {
  /** Rows the arm returns. R4 fuses STAGE1_LIMIT first, then cuts to this. */
  limit: number;
  /** RLS tier, or "bypass" to retrieve across every classification level. */
  permissionLevel: PermissionLevel | "bypass";
  /** Supplying a judge is what makes R4 differ from R3. */
  judgeFactory?: RagasJudgeFactory;
  /** Cut at μ − α·σ. Default 0.5. */
  alpha?: number;
  /** Randomise re-rank presentation order to probe position bias. */
  shuffleSeed?: number;
}

async function retrieve(
  query: EmbeddedQuery,
  strategy: RetrievalStrategy,
  limit: number,
  permissionLevel: PermissionLevel | "bypass"
): Promise<SimilarDocument[]> {
  const opts = { limit, overfetch: ARM_OVERFETCH, rrfK: RRF_K };
  return permissionLevel === "bypass"
    ? querySimilarDocumentsByStrategyBypassRls(query.text, query.vector, strategy, opts)
    : querySimilarDocumentsByStrategy(query.text, query.vector, permissionLevel, strategy, opts);
}

/**
 * Runs one arm over one pre-embedded query.
 *
 * R1 propagates a lexical-leg SQL failure as a throw rather than returning an
 * empty list, so a tooling fault is never recorded as "this strategy retrieved
 * nothing" — see LexicalLegResult in lib/core/db.ts.
 */
export async function runArm(
  arm: ArmId,
  query: EmbeddedQuery,
  options: RunArmOptions
): Promise<ArmResult> {
  const strategy = STRATEGY_FOR_ARM[arm];

  if (arm !== "R4_hybrid_reranked") {
    const started = Date.now();
    const docs = await retrieve(query, strategy, options.limit, options.permissionLevel);
    return { arm, docs, retrievalLatencyMs: Date.now() - started };
  }

  // Stage 1 — fuse a wider candidate set than the final cut will keep.
  const retrievalStarted = Date.now();
  const stage1 = await retrieve(query, strategy, STAGE1_LIMIT, options.permissionLevel);
  const retrievalLatencyMs = Date.now() - retrievalStarted;

  // Stage 2 — judge relevance, then cut at μ − α·σ.
  const rerankStarted = Date.now();
  const outcome = await rerankCandidates(
    {
      query: query.text,
      candidates: stage1.map((d) => ({
        id: d.id,
        text: d.text,
        // Fused score, not `similarity` — that column mixes 1 − cosine with
        // ts_rank_cd and is not a single scale. See irMetrics.adaptiveThreshold.
        rrfScore: d.rrfScore ?? 0,
      })),
      alpha: options.alpha,
      shuffleSeed: options.shuffleSeed,
    },
    options.judgeFactory
  );
  const rerankLatencyMs = Date.now() - rerankStarted;

  const byId = new Map(stage1.map((d) => [d.id, d]));
  const docs = outcome.kept
    .slice(0, options.limit)
    .map((c) => byId.get(c.id))
    .filter((d): d is SimilarDocument => d !== undefined);

  return { arm, docs, retrievalLatencyMs, rerankLatencyMs, rerank: outcome };
}

/**
 * Union of what every arm retrieves for one query, for TREC-style pooling.
 *
 * Run under `permissionLevel: "bypass"` when building an annotation pool, so the
 * pool spans every classification level and recall is not silently measured
 * against a tier-truncated relevant set.
 */
export async function poolCandidates(
  query: EmbeddedQuery,
  options: RunArmOptions & { poolDepth: number }
): Promise<Map<string, { doc: SimilarDocument; ranks: Partial<Record<ArmId, number>> }>> {
  const pool = new Map<string, { doc: SimilarDocument; ranks: Partial<Record<ArmId, number>> }>();

  for (const arm of ARM_IDS) {
    const result = await runArm(arm, query, { ...options, limit: options.poolDepth });
    result.docs.forEach((doc, i) => {
      const existing = pool.get(doc.id);
      if (existing) {
        existing.ranks[arm] = i + 1;
      } else {
        pool.set(doc.id, { doc, ranks: { [arm]: i + 1 } });
      }
    });
  }

  return pool;
}
