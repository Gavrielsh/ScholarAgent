import {
  querySimilarDocuments,
  querySimilarDocumentsBypassRls,
  type QuerySimilarOptions,
  type SimilarDocument,
} from "@/lib/core/db";
import { embedText } from "@/lib/domain/ingestion/embeddings";
import type { PermissionLevel } from "@/lib/security/auth";

export type { SimilarDocument };

export interface RetrieveSimilarOptions extends QuerySimilarOptions {
  /** Job deadline / shutdown cancellation, forwarded to the query embedding. */
  signal?: AbortSignal;
}

/**
 * Embeds the query, or reports that there is nothing to retrieve on.
 *
 * A blank query and an empty embedding both mean the dense leg cannot run, and
 * neither is an error — the caller returns no documents rather than throwing.
 */
async function embedQuery(
  queryText: string,
  options?: number | RetrieveSimilarOptions
): Promise<number[] | null> {
  if (!queryText.trim()) {
    return null;
  }
  const signal = typeof options === "number" ? undefined : options?.signal;
  const queryEmbedding = await embedText(queryText, signal);
  return queryEmbedding.length === 0 ? null : queryEmbedding;
}

/**
 * RLS-scoped hybrid retrieval.
 *
 * Owns the embed step so that `lib/core/db.ts` stays a pure
 * persistence layer: it receives the finished vector and runs SQL.
 */
export async function retrieveSimilarDocuments(
  queryText: string,
  permissionLevel: PermissionLevel,
  options?: number | RetrieveSimilarOptions
): Promise<SimilarDocument[]> {
  const queryEmbedding = await embedQuery(queryText, options);
  if (!queryEmbedding) return [];
  return querySimilarDocuments(queryText, queryEmbedding, permissionLevel, options);
}

/**
 * Unrestricted hybrid retrieval for DLS evaluation (service-role / RLS bypass).
 * Never call this on a user-facing path — it returns every classification level.
 */
export async function retrieveSimilarDocumentsBypassRls(
  queryText: string,
  options?: number | RetrieveSimilarOptions
): Promise<SimilarDocument[]> {
  const queryEmbedding = await embedQuery(queryText, options);
  if (!queryEmbedding) return [];
  return querySimilarDocumentsBypassRls(queryText, queryEmbedding, options);
}
