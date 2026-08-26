import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import {
  MAX_PRIVILEGE_LEVEL,
  MIN_CORPUS_WRITE_LEVEL,
  type AccessLevel,
} from "@/lib/core/db/accessLevel";
import { logError, logWarn } from "@/lib/core/logger";
import { parseNonNegativeInt, parsePositiveInt } from "@/lib/core/env";

// ---------------------------------------------------------------------------
// Connection pools
// ---------------------------------------------------------------------------

let pool: Pool | null = null;
let servicePool: Pool | null = null;

function resolveSsl(): false | { rejectUnauthorized: boolean } {
  if (process.env.PG_SSLMODE === "disable") return false;
  return { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== "false" };
}

/**
 * Removes sslmode or ssl query parameters from the connection string.
 * This prevents the pg driver's connection string parser from overriding
 * our explicit ssl configuration object.
 */
function cleanConnectionString(url: string): string {
  return url.replace(/([?&])(sslmode|ssl)=[^&]+(&|$)/g, "$1").replace(/[?&]$/, "");
}

function createPool(): Pool {
  const rawConnectionString = process.env.DATABASE_URL;
  if (!rawConnectionString) {
    throw new Error("Missing DATABASE_URL environment variable.");
  }

  // Clean the string before passing it to the Pool
  const connectionString = cleanConnectionString(rawConnectionString);

  const instance = new Pool({
    connectionString,
    max: parsePositiveInt(process.env.PG_POOL_MAX, 5),
    min: parsePositiveInt(process.env.PG_POOL_MIN, 1),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: resolveSsl(),
    keepAlive: true,
    allowExitOnIdle: true,
  });

  instance.on("error", (err) => {
    logError("postgres_pool_idle_client_error", err, {
      hint: "Idle pooled client disconnected; subsequent queries acquire a fresh connection.",
    });
  });

  return instance;
}

function createServicePool(): Pool {
  const rawConnectionString = process.env.DATABASE_SERVICE_URL?.trim() || process.env.DATABASE_URL;
  if (!rawConnectionString) {
    throw new Error("Missing DATABASE_SERVICE_URL or DATABASE_URL for service-role access.");
  }

  // Clean the string before passing it to the Pool
  const connectionString = cleanConnectionString(rawConnectionString);

  const instance = new Pool({
    connectionString,
    max: parsePositiveInt(process.env.PG_SERVICE_POOL_MAX, 3),
    min: parseNonNegativeInt(process.env.PG_SERVICE_POOL_MIN, 0),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: resolveSsl(),
    keepAlive: true,
    allowExitOnIdle: true,
  });

  instance.on("error", (err) => {
    logError("postgres_service_pool_idle_client_error", err, {
      hint: "Service-role pooled client disconnected.",
    });
  });

  return instance;
}

/** Lazily initialized singleton pool — safe for serverless warm instances. */
function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

/**
 * Pool for DLS evaluation and other admin paths. Uses DATABASE_SERVICE_URL when set
 * (role should bypass RLS or own the table); otherwise falls back to DATABASE_URL.
 */
function getServicePool(): Pool {
  if (!servicePool) {
    servicePool = createServicePool();
  }
  return servicePool;
}

// ---------------------------------------------------------------------------
// Client checkout / transaction helpers
// ---------------------------------------------------------------------------

/**
 * Runs a callback with a checked-out client. Always releases the client in `finally`,
 * including on connection errors, to avoid pool starvation.
 */
async function withPoolClient<T>(
  poolInstance: Pool,
  event: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  let client: PoolClient | null = null;
  try {
    client = await poolInstance.connect();
    return await fn(client);
  } catch (err) {
    logError(event, err);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withPoolClient(getPool(), "postgres_with_client_error", fn);
}

/** Service-role client — no RLS session variables; used for unrestricted retrieval (DLS). */
export async function withServiceClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withPoolClient(getServicePool(), "postgres_with_service_client_error", fn);
}

export async function withRlsTransaction<T>(
  permissionLevel: AccessLevel,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_permission_level', $1, true)", [
        String(permissionLevel),
      ]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        logError("postgres_rls_rollback_error", rollbackErr);
      }
      throw err;
    }
  });
}

/**
 * Own-history reads/writes. Sets `app.sender_id` so chat_history RLS can allow
 * a user's own rows without the previous "unset GUC = open SELECT" hole.
 */
export async function withSenderTransaction<T>(
  senderId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.sender_id', $1, true)", [senderId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        logError("postgres_sender_rollback_error", rollbackErr);
      }
      throw err;
    }
  });
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  try {
    return await getPool().query<T>(text, params as never);
  } catch (err) {
    logError("postgres_query_error", err, { sqlPreview: text.slice(0, 120) });
    throw err;
  }
}

/** Subset of `pg`'s DatabaseError that we actually branch on. */
interface PostgresErrorShape {
  code?: unknown;
  constraint?: unknown;
}

function asPostgresError(err: unknown): PostgresErrorShape | null {
  if (typeof err !== "object" || err === null) return null;
  return err as PostgresErrorShape;
}

/**
 * True for SQLSTATE 23505 (unique_violation).
 *
 * Treated as success, never as a retryable failure: it means the row this
 * attempt was trying to write is already there, which under BullMQ retries is
 * the expected outcome rather than an error. Retrying would loop forever.
 */
export function isUniqueViolation(err: unknown): boolean {
  return asPostgresError(err)?.code === "23505";
}

export async function closePool(): Promise<void> {
  const errors: unknown[] = [];

  if (pool) {
    const instance = pool;
    pool = null;
    try {
      await instance.end();
    } catch (err) {
      logError("postgres_pool_close_error", err);
      errors.push(err);
    }
  }

  if (servicePool) {
    const instance = servicePool;
    servicePool = null;
    try {
      await instance.end();
    } catch (err) {
      logError("postgres_service_pool_close_error", err);
      errors.push(err);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Multiple errors occurred while closing Postgres pools.");
  }
}

// ---------------------------------------------------------------------------
// pgvector retrieval
// ---------------------------------------------------------------------------

const EMBEDDING_DIMENSION = 768;
/** Per-modality DB fetch cap before RRF / application slicing (RLS recall trap). */
const DEFAULT_RETRIEVAL_OVERFETCH = 200;
const DEFAULT_RRF_K = 60;

export interface SimilarDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown> | null;
  classificationLevel: AccessLevel;
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

type NormalizedQueryOptions = Required<QuerySimilarOptions>;

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
  classification_level: AccessLevel;
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

/**
 * RLS-scoped hybrid retrieval for user-facing access paths.
 *
 * `queryEmbedding` must already be computed — producing it is an ingestion
 * concern, and doing it here would put an HTTP round trip inside the storage
 * layer. Callers go through the ingestion processor's retrieval orchestrator,
 * which owns the embed step and the empty-query short circuit.
 */
export async function querySimilarDocuments(
  queryText: string,
  queryEmbedding: number[],
  permissionLevel: AccessLevel,
  options?: number | QuerySimilarOptions
): Promise<SimilarDocument[]> {
  const opts = normalizeQueryOptions(options);
  const vectorLiteral = toVectorLiteral(queryEmbedding);
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
  queryEmbedding: number[],
  options?: number | QuerySimilarOptions
): Promise<SimilarDocument[]> {
  const opts = normalizeQueryOptions(options);
  const vectorLiteral = toVectorLiteral(queryEmbedding);
  return withServiceClient((client) =>
    executeHybridRetrieval(client, queryText, vectorLiteral, opts)
  );
}

// ---------------------------------------------------------------------------
// Transactional document ingestion (migration 007)
// ---------------------------------------------------------------------------

export interface DocumentChunkRecord {
  text: string;
  /** Ordinal within the document. Backfill derives a deterministic id from it. */
  chunkIndex: number;
  /**
   * Fully-built metadata payload, serialised verbatim into the jsonb column.
   *
   * Composing it is the ingestion processor's job (`buildChunkMetadata`), not
   * this layer's — the key names are a corpus-wide contract that delete and
   * reporting paths filter on, so exactly one module gets to spell them.
   */
  metadata: Record<string, unknown>;
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
  classificationLevel: AccessLevel;
  /** Must be L0 or L1 — set as `app.user_permission_level` so write RLS allows the insert. */
  writePermissionLevel: AccessLevel;
  documentMetadata?: Record<string, unknown>;
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
  if (input.writePermissionLevel > MIN_CORPUS_WRITE_LEVEL) {
    throw new Error("Corpus writes require L0 or L1.");
  }

  const chunkIds = input.chunks.map(() => randomUUID());
  const texts = input.chunks.map((c) => c.text);
  const levels = input.chunks.map(() => input.classificationLevel);
  // Serialised before BEGIN so a dimension mismatch aborts before a connection
  // is ever put into a transaction.
  const embeddings = input.chunks.map((c) => toVectorLiteral(c.embedding));
  const metadata = input.chunks.map((c) => JSON.stringify(c.metadata));

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
  const res = await withRlsTransaction(MAX_PRIVILEGE_LEVEL, (client) =>
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
  classificationLevel: AccessLevel;
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
  classification_level: AccessLevel;
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

  return withRlsTransaction(MAX_PRIVILEGE_LEVEL, async (client) => {
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
  /** Written to every chunk's classification_level column. */
  classificationLevel: AccessLevel;
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

  const chunkIds = input.chunks.map((c) => deterministicChunkId(input.documentId, c.chunkIndex));
  const texts = input.chunks.map((c) => c.text);
  const levels = input.chunks.map(() => input.classificationLevel);
  // Serialised before BEGIN so a dimension mismatch fails before a connection is
  // ever put into a transaction.
  const embeddings = input.chunks.map((c) => toVectorLiteral(c.embedding));
  const metadata = input.chunks.map((c) => JSON.stringify(c.metadata));

  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      // Admin level for the same reason as findDocumentsMissingChunks: without it
      // the emptiness re-check below cannot see a single existing chunk.
      await client.query("SELECT set_config('app.user_permission_level', $1, true)", [
        String(MAX_PRIVILEGE_LEVEL),
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
  await withRlsTransaction(MAX_PRIVILEGE_LEVEL, async (client) => {
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
