import type { PermissionLevel } from "@/lib/auth/types";

/** Row returned from hybrid retrieval, before optional cross-encoder re-ranking. */
export interface RerankCandidate {
  id: string;
  text: string;
  metadata: Record<string, unknown> | null;
  classificationLevel: PermissionLevel;
  /** Primary dense-similarity score when available (cosine-derived). */
  similarity: number;
  /** Reciprocal Rank Fusion score when hybrid retrieval is enabled. */
  rrfScore?: number;
}

/**
 * Pluggable re-ranker (e.g. Cohere rerank-3, BGE cross-encoder).
 * Default implementation is score-based truncation only.
 */
export interface DocumentReranker {
  rerank(query: string, candidates: RerankCandidate[], topK: number): Promise<RerankCandidate[]>;
}

export const defaultScoreReranker: DocumentReranker = {
  async rerank(_query, candidates, topK) {
    const sorted = [...candidates].sort((a, b) => {
      const rb = b.rrfScore ?? b.similarity;
      const ra = a.rrfScore ?? a.similarity;
      if (rb !== ra) return rb - ra;
      return b.similarity - a.similarity;
    });
    return sorted.slice(0, topK);
  },
};
