import { createHash, randomUUID } from "node:crypto";

import { withClient, withRlsTransaction, withServiceClient } from "@/lib/core/db/client";
import type { PoolClient } from "pg";
import { ADMIN_PERMISSION_LEVEL, MANAGER_PERMISSION_LEVEL } from "@/lib/security/auth/rls";
import type { PermissionLevel } from "@/lib/security/auth/types";
import { buildChunkMetadata } from "@/lib/domain/ingestion/processor/chunkMetadata";
import type { Chunk } from "@/lib/domain/ingestion/processor/chunker";
import { embedText } from "@/lib/domain/ingestion/processor/embeddings";
import { logWarn } from "@/lib/core/logger";

const EMBEDDING_DIMENSION = 768;
/** Per-modality DB fetch cap before RRF / application slicing (RLS recall trap). */
const DEFAULT_RETRIEVAL_OVERFETCH = 200;
const DEFAULT_RRF_K = 60;

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
  /** Job deadline / shutdown cancellation, forwarded to the query embedding. */
  signal?: AbortSignal;
}

type NormalizedQueryOptions = Required<Pick<QuerySimilarOptions, "limit" | "overfetch" | "rrfK">> & {
  signal?: AbortSignal;
};

function normalizeQueryOptions(
  arg?: number | QuerySimilarOptions
): NormalizedQueryOptions {
  if (typeof arg === "number") {
    return { limit: arg, overfetch: DEFAULT_RETRIEVAL_OVERFETCH, rrfK: DEFAULT_RRF_K };
  }
  return {
    limit: arg?.limit ?? 5,
    overfetch: arg?.overfetch ?? DEFAULT_RETRIEVAL_OVERFETCH,
    rrfK: arg?.rrfK ?? DEFAULT_RRF_K,
    signal: arg?.signal,
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
  opts: NormalizedQueryOptions
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
): Promise<{ vectorLiteral: string; opts: NormalizedQueryOptions } | null> {
  const opts = normalizeQueryOptions(options);
  if (!queryText.trim()) {
    return null;
  }

  const queryEmbedding = await embedText(queryText, opts.signal);
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
  /** Meta message id. Doubles as the idempotency key (partial unique index). */
  externalMessageId: string | null;
  uploadedByUserId: string;
  uploadedByPhone: string | null;
  classificationLevel: PermissionLevel;
  /** Must be L0 or L1 — set as `app.user_permission_level` so write RLS allows the insert. */
  writePermissionLevel: PermissionLevel;
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
 * A two-step write (chunks first, then the document row) can leave orphaned
 * chunks in the corpus if the process dies between the two statements, and
 * orphaned chunks are unreachable by
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
  if (input.writePermissionLevel > MANAGER_PERMISSION_LEVEL) {
    throw new Error("Corpus writes require L0 or L1.");
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
      await client.query("SELECT set_config('app.user_permission_level', $1, true)", [
        String(input.writePermissionLevel),
      ]);

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
 *
 * Since migration 008 the reverse direction is automatic: deleting the
 * ingested_documents row cascades to these chunks via trigger.
 */
export async function hardDeleteKnowledgeChunksByDocumentId(documentId: string): Promise<number> {
  if (!documentId.trim()) return 0;
  const res = await withRlsTransaction(ADMIN_PERMISSION_LEVEL, (client) =>
    client.query(`DELETE FROM knowledge_base WHERE metadata->>'document_id' = $1`, [documentId])
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Reconciliation (scripts/reconcile_documents.ts)
// ---------------------------------------------------------------------------

/** One row of the document registry, as the reconciler needs to see it. */
export interface DocumentRegistryRow {
  documentId: string;
  source: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256: string | null;
  externalMediaId: string | null;
  externalMessageId: string | null;
  uploadedByUserId: string;
  uploadedByPhone: string | null;
  classificationLevel: PermissionLevel;
  chunkCount: number;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
}

const DOCUMENTS_MISSING_CHUNKS_SQL = `
  SELECT d.id, d.source, d.filename, d.mime_type, d.size_bytes, d.sha256,
         d.external_media_id, d.external_message_id, d.uploaded_by_user_id,
         d.uploaded_by_phone, d.classification_level, d.chunk_count, d.status,
         d.metadata, d.created_at
  FROM ingested_documents d
  WHERE NOT EXISTS (
    SELECT 1
    FROM knowledge_base kb
    WHERE kb.metadata->>'document_id' = d.id::text
  )
    AND ($1::uuid IS NULL OR d.id = $1::uuid)
  ORDER BY d.created_at ASC, d.id ASC
  LIMIT $2;
`;

type DocumentRegistrySqlRow = {
  id: string;
  source: string;
  filename: string;
  mime_type: string;
  size_bytes: string | number | null;
  sha256: string | null;
  external_media_id: string | null;
  external_message_id: string | null;
  uploaded_by_user_id: string;
  uploaded_by_phone: string | null;
  classification_level: PermissionLevel;
  chunk_count: number;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: Date | string | null;
};

function mapRegistryRow(row: DocumentRegistrySqlRow): DocumentRegistryRow {
  return {
    documentId: row.id,
    source: row.source,
    filename: row.filename,
    mimeType: row.mime_type,
    // BIGINT arrives as a string from node-postgres.
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: row.sha256,
    externalMediaId: row.external_media_id,
    externalMessageId: row.external_message_id,
    uploadedByUserId: row.uploaded_by_user_id,
    uploadedByPhone: row.uploaded_by_phone,
    classificationLevel: row.classification_level,
    chunkCount: row.chunk_count,
    status: row.status,
    metadata: row.metadata,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at ?? null,
  };
}

/**
 * Registered documents that produced no chunks — the ingestion transaction never
 * committed its half, or the chunks were deleted without the registry row.
 *
 * Runs at admin privilege on purpose, and this is load-bearing rather than
 * convenience: knowledge_base is FORCE ROW LEVEL SECURITY with a SELECT policy of
 * `classification_level >= current_setting('app.user_permission_level', true)`.
 * With that setting unset the comparison is NULL, no chunk is visible, and the
 * NOT EXISTS above would match *every* document in the registry — handing the
 * reconciler an instruction to re-embed the entire corpus. Level 0 sees all tiers.
 */
export async function findDocumentsMissingChunks(
  options: { limit?: number; documentId?: string | null } = {}
): Promise<DocumentRegistryRow[]> {
  const limit = Math.max(1, options.limit ?? 100);
  const documentId = options.documentId?.trim() || null;

  return withRlsTransaction(ADMIN_PERMISSION_LEVEL, async (client) => {
    const res = await client.query<DocumentRegistrySqlRow>(DOCUMENTS_MISSING_CHUNKS_SQL, [
      documentId,
      limit,
    ]);
    return res.rows.map(mapRegistryRow);
  });
}

/**
 * Fixed namespace for name-based chunk ids. Any constant UUID works; it only has
 * to stay the same forever, because changing it changes every derived id.
 */
const RECONCILE_CHUNK_ID_NAMESPACE = "6f5b1c9e-8f3a-4d5e-9c2b-1a7d0e4f6b83";

/**
 * RFC 4122 §4.3 name-based (v5) UUID over `documentId:chunkIndex`.
 *
 * This is what makes a re-run cheap instead of duplicating: the ids a document
 * yields are a pure function of the document and the chunk ordinal, so the bulk
 * insert's ON CONFLICT (id) DO UPDATE turns a second pass over the same text into
 * an in-place overwrite rather than a second copy of the document in the corpus.
 * randomUUID() would produce a fresh set every run.
 */
function deterministicChunkId(documentId: string, chunkIndex: number): string {
  const namespace = Buffer.from(RECONCILE_CHUNK_ID_NAMESPACE.replace(/-/g, ""), "hex");
  const digest = createHash("sha1")
    .update(namespace)
    .update(`${documentId}:${chunkIndex}`, "utf8")
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export interface BackfillDocumentChunksInput {
  /** Must already exist in ingested_documents. */
  documentId: string;
  filename: string;
  mimeType: string;
  uploadedByUserId: string;
  classificationLevel: PermissionLevel;
  /** Extras merged into every chunk's metadata (source channel, provenance…). */
  chunkMetadata?: Record<string, unknown>;
  chunks: DocumentChunkRecord[];
}

export interface BackfillDocumentChunksResult {
  insertedChunkIds: string[];
  /**
   * True when the document already had chunks by the time the row lock was
   * granted — a concurrent reconciler or a re-ingest won the race. Nothing was
   * written; the caller should report a no-op, not a failure.
   */
  alreadyPresent: boolean;
}

/**
 * Attaches chunks to a document row that already exists, in one transaction.
 *
 * Counterpart to `insertDocumentWithChunks`, which owns the first-ingestion path
 * and creates the registry row itself. Here the row is what survived and the
 * chunks are what is missing, so the transaction takes a `FOR UPDATE` lock on it,
 * re-checks emptiness *inside* that lock, writes the chunks, and only then trusts
 * chunk_count enough to correct it. Two reconcilers pointed at the same document
 * cannot both pass the re-check.
 *
 * Embeddings must be precomputed: an HTTP round trip inside an open transaction
 * pins a pool connection for the length of the whole embedding run.
 */
export async function backfillDocumentChunks(
  input: BackfillDocumentChunksInput
): Promise<BackfillDocumentChunksResult> {
  if (input.chunks.length === 0) {
    throw new Error("Cannot backfill a document with zero chunks.");
  }

  const chunkIds = input.chunks.map((c) => deterministicChunkId(input.documentId, c.chunk.index));
  const texts = input.chunks.map((c) => c.text);
  const levels = input.chunks.map(() => input.classificationLevel);
  // Serialised before BEGIN so a dimension mismatch fails before a connection is
  // ever put into a transaction.
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
      // Admin level for the same reason as findDocumentsMissingChunks: without it
      // the emptiness re-check below cannot see a single existing chunk.
      await client.query("SELECT set_config('app.user_permission_level', $1, true)", [
        String(ADMIN_PERMISSION_LEVEL),
      ]);

      const locked = await client.query<{ id: string }>(
        "SELECT id FROM ingested_documents WHERE id = $1 FOR UPDATE;",
        [input.documentId]
      );
      if (locked.rowCount === 0) {
        throw new Error(
          `ingested_documents row ${input.documentId} no longer exists; refusing to write orphaned chunks.`
        );
      }

      const existing = await client.query<{ chunks: string }>(
        `SELECT count(*) AS chunks FROM knowledge_base WHERE metadata->>'document_id' = $1;`,
        [input.documentId]
      );
      if (Number(existing.rows[0]?.chunks ?? 0) > 0) {
        await client.query("COMMIT");
        return { insertedChunkIds: [], alreadyPresent: true };
      }

      const chunkRes = await client.query<{ id: string }>(BULK_UPSERT_SQL, [
        chunkIds,
        texts,
        metadata,
        levels,
        embeddings,
      ]);

      // A short count means UNNEST dropped rows (mismatched array lengths).
      // Throwing rolls the whole document back rather than leaving it partially
      // embedded, which would then look reconciled to the next run.
      if (chunkRes.rows.length !== input.chunks.length) {
        throw new Error(
          `Chunk backfill wrote ${chunkRes.rows.length} rows, expected ${input.chunks.length}.`
        );
      }

      await client.query(
        `UPDATE ingested_documents
            SET chunk_count = $2,
                status = 'ingested',
                metadata = coalesce(metadata, '{}'::jsonb)
                           || jsonb_build_object('reconciled_at', to_jsonb(now()))
                           - 'reconcile_error'
          WHERE id = $1;`,
        [input.documentId, input.chunks.length]
      );

      await client.query("COMMIT");

      return { insertedChunkIds: chunkRes.rows.map((row) => row.id), alreadyPresent: false };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        logWarn(
          "document_backfill_rollback_failed",
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          { documentId: input.documentId }
        );
      }
      throw err;
    }
  });
}

/**
 * Records why a document could not be reconciled, on the document itself.
 *
 * The reconciler's selection criterion is "has no chunks", so a document it
 * cannot repair reappears on every subsequent run. Without this, the reason —
 * source file gone, unsupported type, embedding provider down — lives only in the
 * log line of whichever run first hit it.
 */
export async function markDocumentReconcileFailure(
  documentId: string,
  reason: string
): Promise<void> {
  await withRlsTransaction(ADMIN_PERMISSION_LEVEL, async (client) => {
    await client.query(
      `UPDATE ingested_documents
          SET status = 'reconcile_failed',
              metadata = coalesce(metadata, '{}'::jsonb)
                         || jsonb_build_object(
                              'reconcile_error', $2::text,
                              'reconcile_attempted_at', to_jsonb(now())
                            )
        WHERE id = $1;`,
      [documentId, reason.slice(0, 500)]
    );
  });
}
