import { withClient, withRlsTransaction } from "@/lib/db/client";
import type { PermissionLevel } from "@/lib/auth/types";
import { embedText } from "@/lib/ingestion/embeddings";

const EMBEDDING_DIMENSION = 768;
/** Per-modality DB fetch cap before RRF / application slicing (RLS recall trap). */
export const DEFAULT_RETRIEVAL_OVERFETCH = 200;
const DEFAULT_RRF_K = 60;

export interface EmbeddingRecord {
  id?: string;
  text: string;
  classificationLevel: PermissionLevel;
  metadata?: Record<string, unknown>;
  embedding?: number[];
}

export interface SimilarDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown> | null;
  classificationLevel: PermissionLevel;
  /** Dense-vector cosine similarity when available. */
  similarity: number;
  /** Fused RRF score when hybrid retrieval runs. */
  rrfScore?: number;
}

export interface QuerySimilarOptions {
  /** Rows returned after RRF merge + sort (default 5). */
  limit?: number;
  /** HNSW / BM25 leg cap each — fetch wide before RLS shrinks the effective set. */
  overfetch?: number;
  rrfK?: number;
}

function normalizeQueryOptions(arg?: number | QuerySimilarOptions): Required<QuerySimilarOptions> {
  if (typeof arg === "number") {
    return { limit: arg, overfetch: DEFAULT_RETRIEVAL_OVERFETCH, rrfK: DEFAULT_RRF_K };
  }
  return {
    limit: arg?.limit ?? 5,
    overfetch: arg?.overfetch ?? DEFAULT_RETRIEVAL_OVERFETCH,
    rrfK: arg?.rrfK ?? DEFAULT_RRF_K,
  };
}

function toVectorLiteral(vector: number[]): string {
  if (vector.length === 0) {
    throw new Error("Cannot serialise an empty embedding vector.");
  }
  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding dimension mismatch: got ${vector.length}, expected ${EMBEDDING_DIMENSION}.`
    );
  }
  return `[${vector.join(",")}]`;
}

export async function upsertDocument(document: EmbeddingRecord): Promise<string> {
  if (!document.text.trim()) {
    throw new Error("Cannot insert document with empty text.");
  }

  const embedding =
    document.embedding && document.embedding.length > 0
      ? document.embedding
      : await embedText(document.text);

  if (embedding.length === 0) {
    throw new Error("Embedding generation returned an empty vector.");
  }

  const vectorLiteral = toVectorLiteral(embedding);
  const metadataJson = JSON.stringify(document.metadata ?? {});

  const sql = document.id
    ? `
        INSERT INTO knowledge_base (id, content, metadata, classification_level, embedding)
        VALUES ($1, $2, $3::jsonb, $4, $5::vector)
        ON CONFLICT (id) DO UPDATE
          SET content = EXCLUDED.content,
              metadata = EXCLUDED.metadata,
              classification_level = EXCLUDED.classification_level,
              embedding = EXCLUDED.embedding
        RETURNING id;
      `
    : `
        INSERT INTO knowledge_base (content, metadata, classification_level, embedding)
        VALUES ($1, $2::jsonb, $3, $4::vector)
        RETURNING id;
      `;

  const params = document.id
    ? [document.id, document.text, metadataJson, document.classificationLevel, vectorLiteral]
    : [document.text, metadataJson, document.classificationLevel, vectorLiteral];

  const result = await withClient((client) => client.query<{ id: string }>(sql, params));
  const insertedId = result.rows[0]?.id;
  if (!insertedId) {
    throw new Error("Document insert did not return an id.");
  }
  return insertedId;
}

export async function upsertDocumentsBatch(
  documents: EmbeddingRecord[]
): Promise<{ insertedIds: string[]; failures: Array<{ index: number; error: string }> }> {
  const insertedIds: string[] = [];
  const failures: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < documents.length; i++) {
    try {
      const id = await upsertDocument(documents[i]);
      insertedIds.push(id);
    } catch (err) {
      failures.push({
        index: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { insertedIds, failures };
}

type RetrievedRow = {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  classification_level: PermissionLevel;
  similarity: number;
};

function mapRow(row: RetrievedRow): SimilarDocument {
  return {
    id: row.id,
    text: row.content,
    metadata: row.metadata,
    classificationLevel: row.classification_level,
    similarity: Number(row.similarity),
  };
}

/**
 * Reciprocal Rank Fusion over two ranked lists (Cormack et al. style), k≈60.
 */
function reciprocalRankFusion(
  vectorRanked: SimilarDocument[],
  bm25Ranked: SimilarDocument[],
  rrfK: number
): SimilarDocument[] {
  const byId = new Map<string, { doc: SimilarDocument; rrf: number }>();

  const bump = (doc: SimilarDocument, rank: number) => {
    const inc = 1 / (rrfK + rank);
    const cur = byId.get(doc.id);
    if (!cur) {
      byId.set(doc.id, { doc: { ...doc }, rrf: inc });
    } else {
      cur.rrf += inc;
      cur.doc.similarity = Math.max(cur.doc.similarity, doc.similarity);
    }
  };

  vectorRanked.forEach((doc, i) => bump(doc, i + 1));
  bm25Ranked.forEach((doc, i) => bump(doc, i + 1));

  return [...byId.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .map(({ doc, rrf }) => ({ ...doc, rrfScore: rrf }));
}

// RLS-aware hybrid retrieval: dense HNSW + BM25 (tsvector), fused with RRF.
export async function querySimilarDocuments(
  queryText: string,
  permissionLevel: PermissionLevel,
  options?: number | QuerySimilarOptions
): Promise<SimilarDocument[]> {
  const opts = normalizeQueryOptions(options);
  if (!queryText.trim()) {
    return [];
  }

  const queryEmbedding = await embedText(queryText);
  if (queryEmbedding.length === 0) {
    return [];
  }

  const vectorLiteral = toVectorLiteral(queryEmbedding);
  const overfetch = opts.overfetch;

  const vectorSql = `
    SELECT id, content, metadata, classification_level,
           1 - (embedding <=> $1::vector) AS similarity
    FROM knowledge_base
    ORDER BY embedding <=> $1::vector
    LIMIT $2;
  `;

  const bm25Sql = `
    SELECT id, content, metadata, classification_level,
           ts_rank_cd(content_tsv, websearch_to_tsquery('simple', $1)) AS similarity
    FROM knowledge_base
    WHERE content_tsv @@ websearch_to_tsquery('simple', $1)
    ORDER BY similarity DESC
    LIMIT $2;
  `;

  const fused = await withRlsTransaction(permissionLevel, async (client) => {
    const vecRes = await client.query<RetrievedRow>(vectorSql, [vectorLiteral, overfetch]);
    const vectorRows = vecRes.rows.map(mapRow);

    let bm25Rows: SimilarDocument[] = [];
    try {
      const bmRes = await client.query<RetrievedRow>(bm25Sql, [queryText, overfetch]);
      bm25Rows = bmRes.rows.map(mapRow);
    } catch (err) {
      // Older DBs without content_tsv / GIN — fall back to dense-only.
      console.warn("BM25 leg skipped (schema or tsquery error):", err);
    }

    if (bm25Rows.length === 0) {
      return vectorRows.slice(0, opts.limit);
    }

    const merged = reciprocalRankFusion(vectorRows, bm25Rows, opts.rrfK);
    return merged.slice(0, opts.limit);
  });

  return fused;
}

/**
 * Hard-delete every chunk belonging to a logical source document (metadata.document_id).
 * Call from a trusted webhook after upstream CMS deletion or full re-ingest.
 */
export async function hardDeleteKnowledgeChunksByDocumentId(documentId: string): Promise<number> {
  if (!documentId.trim()) return 0;
  const res = await withClient((client) =>
    client.query(`DELETE FROM knowledge_base WHERE metadata->>'document_id' = $1`, [documentId])
  );
  return res.rowCount ?? 0;
}
