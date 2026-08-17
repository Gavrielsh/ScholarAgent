import { randomUUID } from "node:crypto";

import { withClient, withRlsTransaction, withServiceClient } from "@/lib/db/client";
import type { PoolClient } from "pg";
import type { PermissionLevel } from "@/lib/auth/types";
import { buildChunkMetadata } from "@/lib/ingestion/chunkMetadata";
import type { Chunk } from "@/lib/ingestion/chunker";
import { embedText, embedTextBatch } from "@/lib/ingestion/embeddings";
import { logWarn } from "@/lib/logger";

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

const BULK_UPSERT_SQL = `
  INSERT INTO knowledge_base (id, content, metadata, classification_level, embedding)
  SELECT u.id, u.content, u.metadata::jsonb, u.classification_level, u.embedding::vector
  FROM UNNEST($1::uuid[], $2::text[], $3::text[], $4::int[], $5::text[]) AS u(
    id, content, metadata, classification_level, embedding
  )
  ON CONFLICT (id) DO UPDATE
    SET content = EXCLUDED.content,
        metadata = EXCLUDED.metadata,
        classification_level = EXCLUDED.classification_level,
        embedding = EXCLUDED.embedding
  RETURNING id;
`;

type PreparedBatchRow = {
  sourceIndex: number;
  id: string;
  text: string;
  metadataJson: string;
  classificationLevel: PermissionLevel;
  embedding?: number[];
};

export async function upsertDocumentsBatch(
  documents: EmbeddingRecord[]
): Promise<{ insertedIds: string[]; failures: Array<{ index: number; error: string }> }> {
  const insertedIds: string[] = [];
  const failures: Array<{ index: number; error: string }> = [];

  if (documents.length === 0) {
    return { insertedIds, failures };
  }

  const prepared: PreparedBatchRow[] = [];

  for (let i = 0; i < documents.length; i++) {
    const document = documents[i];
    try {
      if (!document.text.trim()) {
        throw new Error("Cannot insert document with empty text.");
      }
      prepared.push({
        sourceIndex: i,
        id: document.id ?? randomUUID(),
        text: document.text,
        metadataJson: JSON.stringify(document.metadata ?? {}),
        classificationLevel: document.classificationLevel,
        embedding:
          document.embedding && document.embedding.length > 0
            ? document.embedding
            : undefined,
      });
    } catch (err) {
      failures.push({
        index: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (prepared.length === 0) {
    return { insertedIds, failures };
  }

  const needsEmbedding = prepared.filter((row) => !row.embedding);
  if (needsEmbedding.length > 0) {
    try {
      const vectors = await embedTextBatch(needsEmbedding.map((row) => row.text));
      if (vectors.length !== needsEmbedding.length) {
        throw new Error(
          `Embedding count mismatch: got ${vectors.length}, expected ${needsEmbedding.length}.`
        );
      }
      needsEmbedding.forEach((row, idx) => {
        row.embedding = vectors[idx];
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const row of needsEmbedding) {
        failures.push({ index: row.sourceIndex, error: message });
      }
      const surviving = prepared.filter(
        (row) => row.embedding && row.embedding.length > 0
      );
      prepared.length = 0;
      prepared.push(...surviving);
    }
  }

  const ready: PreparedBatchRow[] = [];
  for (const row of prepared) {
    try {
      if (!row.embedding || row.embedding.length === 0) {
        throw new Error("Embedding generation returned an empty vector.");
      }
      toVectorLiteral(row.embedding);
      ready.push(row);
    } catch (err) {
      failures.push({
        index: row.sourceIndex,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (ready.length === 0) {
    return { insertedIds, failures };
  }

  const ids = ready.map((row) => row.id);
  const texts = ready.map((row) => row.text);
  const metadata = ready.map((row) => row.metadataJson);
  const levels = ready.map((row) => row.classificationLevel);
  const embeddings = ready.map((row) => toVectorLiteral(row.embedding!));

  try {
    const result = await withClient((client) =>
      client.query<{ id: string }>(BULK_UPSERT_SQL, [ids, texts, metadata, levels, embeddings])
    );
    for (const row of result.rows) {
      if (row.id) {
        insertedIds.push(row.id);
      }
    }
    if (insertedIds.length !== ready.length) {
      throw new Error(
        `Bulk upsert returned ${insertedIds.length} ids, expected ${ready.length}.`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logWarn("knowledge_base_bulk_upsert_failed", message, {
      batchSize: ready.length,
      sqlPreview: BULK_UPSERT_SQL.slice(0, 120),
      stack,
    });
    for (const row of ready) {
      failures.push({ index: row.sourceIndex, error: message });
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

async function executeHybridRetrieval(
  client: PoolClient,
  queryText: string,
  vectorLiteral: string,
  opts: Required<QuerySimilarOptions>
): Promise<SimilarDocument[]> {
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

  const vecRes = await client.query<RetrievedRow>(vectorSql, [vectorLiteral, overfetch]);
  const vectorRows = vecRes.rows.map(mapRow);

  let bm25Rows: SimilarDocument[] = [];
  try {
    const bmRes = await client.query<RetrievedRow>(bm25Sql, [queryText, overfetch]);
    bm25Rows = bmRes.rows.map(mapRow);
  } catch (err) {
    logWarn(
      "retrieval_bm25_leg_skipped",
      err instanceof Error ? err.message : String(err),
      {
        sqlPreview: bm25Sql.slice(0, 120),
        stack: err instanceof Error ? err.stack : undefined,
      }
    );
  }

  if (bm25Rows.length === 0) {
    return vectorRows.slice(0, opts.limit);
  }

  const merged = reciprocalRankFusion(vectorRows, bm25Rows, opts.rrfK);
  return merged.slice(0, opts.limit);
}

async function prepareHybridRetrieval(
  queryText: string,
  options?: number | QuerySimilarOptions
): Promise<{ vectorLiteral: string; opts: Required<QuerySimilarOptions> } | null> {
  const opts = normalizeQueryOptions(options);
  if (!queryText.trim()) {
    return null;
  }

  const queryEmbedding = await embedText(queryText);
  if (queryEmbedding.length === 0) {
    return null;
  }

  return { vectorLiteral: toVectorLiteral(queryEmbedding), opts };
}

/** RLS-scoped hybrid retrieval for user-facing access paths. */
export async function querySimilarDocuments(
  queryText: string,
  permissionLevel: PermissionLevel,
  options?: number | QuerySimilarOptions
): Promise<SimilarDocument[]> {
  const prepared = await prepareHybridRetrieval(queryText, options);
  if (!prepared) return [];

  const { vectorLiteral, opts } = prepared;
  return withRlsTransaction(permissionLevel, (client) =>
    executeHybridRetrieval(client, queryText, vectorLiteral, opts)
  );
}

/**
 * Unrestricted hybrid retrieval for DLS evaluation (service-role / RLS bypass).
 * Returns chunks across all classification levels so leakage can be measured.
 */
export async function querySimilarDocumentsBypassRls(
  queryText: string,
  options?: number | QuerySimilarOptions
): Promise<SimilarDocument[]> {
  const prepared = await prepareHybridRetrieval(queryText, options);
  if (!prepared) return [];

  const { vectorLiteral, opts } = prepared;
  return withServiceClient((client) =>
    executeHybridRetrieval(client, queryText, vectorLiteral, opts)
  );
}

// ---------------------------------------------------------------------------
// Transactional document ingestion (migration 007)
// ---------------------------------------------------------------------------

export interface DocumentChunkRecord {
  text: string;
  chunk: Pick<Chunk, "index" | "charStart" | "charEnd">;
  /** Pre-computed. Embedding inside the transaction would hold it open for minutes. */
  embedding: number[];
}

export interface IngestedDocumentRecord {
  documentId: string;
  /** 'whatsapp' | 'upload_api' | … */
  source: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256: string | null;
  externalMediaId: string | null;
  /** Meta message id. Doubles as the idempotency key (migration 007). */
  externalMessageId: string | null;
  uploadedByUserId: string;
  uploadedByPhone: string | null;
  classificationLevel: PermissionLevel;
  documentMetadata?: Record<string, unknown>;
  /** Channel-specific extras merged into every chunk's metadata. */
  chunkMetadata?: Record<string, unknown>;
  chunks: DocumentChunkRecord[];
}

export interface InsertDocumentResult {
  documentId: string;
  insertedChunkIds: string[];
  /** True when a previous attempt already committed this exact message. */
  alreadyIngested: boolean;
}

const INSERT_INGESTED_DOCUMENT_SQL = `
  INSERT INTO ingested_documents (
    id, source, filename, mime_type, size_bytes, sha256,
    external_media_id, external_message_id, uploaded_by_user_id, uploaded_by_phone,
    classification_level, chunk_count, metadata
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
  ON CONFLICT (external_message_id) WHERE external_message_id IS NOT NULL
  DO NOTHING
  RETURNING id;
`;

/**
 * Writes the document row and all of its chunks in ONE transaction.
 *
 * The alternative — `upsertDocumentsBatch` followed by a separate document
 * insert — can leave orphaned chunks in the corpus if the process dies between
 * the two statements, and orphaned chunks are unreachable by
 * `hardDeleteKnowledgeChunksByDocumentId` bookkeeping while still being fully
 * retrievable by RAG. Either everything lands or nothing does.
 *
 * Embeddings must already be computed: an HTTP round trip inside an open
 * transaction pins a pool connection for the whole embedding run.
 */
export async function insertDocumentWithChunks(
  input: IngestedDocumentRecord
): Promise<InsertDocumentResult> {
  if (input.chunks.length === 0) {
    throw new Error("Cannot ingest a document with zero chunks.");
  }

  const chunkIds = input.chunks.map(() => randomUUID());
  const texts = input.chunks.map((c) => c.text);
  const levels = input.chunks.map(() => input.classificationLevel);
  // Serialised before BEGIN so a dimension mismatch aborts before a connection
  // is ever put into a transaction.
  const embeddings = input.chunks.map((c) => toVectorLiteral(c.embedding));
  const metadata = input.chunks.map((c) =>
    JSON.stringify(
      buildChunkMetadata({
        documentId: input.documentId,
        filename: input.filename,
        mimeType: input.mimeType,
        uploadedByUserId: input.uploadedByUserId,
        classificationLevel: input.classificationLevel,
        chunk: c.chunk,
        extra: input.chunkMetadata,
      })
    )
  );

  return withClient(async (client) => {
    try {
      await client.query("BEGIN");

      const documentRes = await client.query<{ id: string }>(INSERT_INGESTED_DOCUMENT_SQL, [
        input.documentId,
        input.source,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        input.sha256,
        input.externalMediaId,
        input.externalMessageId,
        input.uploadedByUserId,
        input.uploadedByPhone,
        input.classificationLevel,
        input.chunks.length,
        JSON.stringify(input.documentMetadata ?? {}),
      ]);

      // DO NOTHING fired: this message was ingested by an earlier attempt. Writing
      // the chunks again would duplicate the whole document in the corpus, so the
      // transaction closes here and the caller reports success.
      if (documentRes.rowCount === 0) {
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM ingested_documents WHERE external_message_id = $1 LIMIT 1;",
          [input.externalMessageId]
        );
        await client.query("COMMIT");
        return {
          documentId: existing.rows[0]?.id ?? input.documentId,
          insertedChunkIds: [],
          alreadyIngested: true,
        };
      }

      const chunkRes = await client.query<{ id: string }>(BULK_UPSERT_SQL, [
        chunkIds,
        texts,
        metadata,
        levels,
        embeddings,
      ]);

      // A short count means UNNEST silently dropped rows (mismatched array
      // lengths). Throwing rolls back the document row too, rather than
      // registering a document whose corpus content is partial.
      if (chunkRes.rows.length !== input.chunks.length) {
        throw new Error(
          `Chunk insert wrote ${chunkRes.rows.length} rows, expected ${input.chunks.length}.`
        );
      }

      await client.query("COMMIT");

      return {
        documentId: input.documentId,
        insertedChunkIds: chunkRes.rows.map((row) => row.id),
        alreadyIngested: false,
      };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        logWarn(
          "document_ingestion_rollback_failed",
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          { documentId: input.documentId }
        );
      }
      throw err;
    }
  });
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
