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
    if (isConnectionLostError(err)) {
      logError(
        "postgres_connection_lost",
        new Error("Database connection lost. The pool will open a fresh connection on the next query."),
        { originalEvent: event }
      );
    }
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

/**
 * Service-role client — no RLS session variables and NO role switch, so it
 * retrieves across every classification level.
 *
 * This is the deliberate escape hatch, and the only one. The evaluation
 * harness's positive control depends on it: proving a seeded canary is
 * reachable at all is what makes a later 0% leakage result mean anything. Never
 * reachable from a user-facing path.
 */
export async function withServiceClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withPoolClient(getServicePool(), "postgres_with_service_client_error", fn);
}

/**
 * The unprivileged role RLS policies are evaluated against.
 *
 * 001_initial_schema.sql FORCEs row-level security, but a superuser or a role
 * holding BYPASSRLS skips every policy regardless. The connecting (owner) role
 * is often exactly that — the Postgres Docker image always creates it as a
 * superuser — so the owner connection is kept out of the request path:
 * dropping to this NOBYPASSRLS role inside each transaction is what makes the
 * policies take effect (defense in depth).
 *
 * Overridable because a managed database may already provide an equivalent
 * role under another name. Whatever it is, it must hold neither SUPERUSER nor
 * BYPASSRLS; migration 001 asserts that for the default and fails if violated.
 */
const APP_ROLE = process.env.PG_APP_ROLE ?? "scholaragent_app";

/**
 * Validates a role name that will be interpolated into SQL.
 *
 * `SET LOCAL ROLE` takes an identifier, not a value, so it cannot be bound with
 * $1. The name therefore reaches the statement by interpolation, and the only
 * thing standing between PG_APP_ROLE and arbitrary SQL is this check. Accepts
 * exactly what PostgreSQL accepts as an unquoted identifier: a leading letter
 * or underscore, then letters, digits, underscores or dollar signs.
 *
 * Exported for testing — this is the injection boundary, so it is tested
 * directly rather than only through a code path that needs a database.
 */
export function assertSqlIdentifier(name: string, source: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`${source} ${JSON.stringify(name)} is not a plain SQL identifier.`);
  }
  return name;
}

/**
 * Enters the unprivileged role for the remainder of the transaction.
 *
 * SET LOCAL is transaction-scoped: it reverts on COMMIT and on ROLLBACK, so the
 * role cannot leak onto the next user of a pooled connection.
 *
 * This fails closed. If the role does not exist — migration 001 has not been
 * applied — the transaction aborts rather than proceeding. Continuing would run
 * the query as the connecting superuser with every policy bypassed, which is
 * the vulnerability itself, and it would do so silently.
 */
async function enterAppRole(client: PoolClient): Promise<void> {
  try {
    await client.query(`SET LOCAL ROLE ${assertSqlIdentifier(APP_ROLE, "PG_APP_ROLE")}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not assume the RLS application role "${APP_ROLE}": ${detail}. ` +
        "Row-level security would not be enforced without it, so this query was " +
        "refused rather than run with policies bypassed. Apply " +
        "migrations/001_initial_schema.sql (npm run migrate), or set PG_APP_ROLE " +
        "to an existing NOBYPASSRLS role the connection is a member of."
    );
  }
}

export async function withRlsTransaction<T>(
  permissionLevel: AccessLevel,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      // GUC first, then the role switch: the session variable is set while the
      // connecting role is still in effect, so a future tightening of what the
      // app role may configure cannot break tier propagation.
      await client.query("SELECT set_config('app.user_permission_level', $1, true)", [
        String(permissionLevel),
      ]);
      await enterAppRole(client);
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
      // chat_history is FORCE RLS with own-history policies, so this path was
      // bypassed by exactly the same superuser problem: any sender could read
      // any sender's history. It needs the role switch as much as the tier path.
      await enterAppRole(client);
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
    if (isConnectionLostError(err)) {
      logError(
        "postgres_connection_lost",
        new Error("Database connection lost. The pool will open a fresh connection on the next query."),
        { originalEvent: "postgres_query_error" }
      );
    }
    throw err;
  }
}

/** Subset of `pg`'s DatabaseError that we actually branch on. */
interface PostgresErrorShape {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
}

function asPostgresError(err: unknown): PostgresErrorShape | null {
  if (typeof err !== "object" || err === null) return null;
  return err as PostgresErrorShape;
}

/**
 * TCP/Postgres codes and messages that mean the connection itself dropped
 * (network blip, DB restart, admin shutdown) rather than the query being
 * malformed. Distinguishing the two lets callers emit an actionable
 * "connection lost" signal instead of one indistinguishable from a SQL bug.
 */
const CONNECTION_LOST_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

const CONNECTION_LOST_MESSAGE_RE =
  /connection terminated|connection ended unexpectedly|server closed the connection|timeout expired/i;

function isConnectionLostError(err: unknown): boolean {
  const shape = asPostgresError(err);
  if (!shape) return false;
  if (typeof shape.code === "string" && CONNECTION_LOST_CODES.has(shape.code)) return true;
  return typeof shape.message === "string" && CONNECTION_LOST_MESSAGE_RE.test(shape.message);
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
  /**
   * The parent chunk this row was indexed under, or null for a flat chunk.
   *
   * On a result that has been through parent resolution this is null and `id`
   * is already the parent's id — see resolveParentChunks.
   */
  parentId?: string | null;
  /**
   * The child chunk that actually matched, when `text` was widened to its
   * parent. Kept so a retrieval trace can still say which small chunk scored.
   */
  matchedChildId?: string;
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

/**
 * Bulk chunk upsert.
 *
 * `is_parent` and `parent_id` arrive as arrays alongside the rest (migration
 * 004). Parents and children go in one statement so a child can never be
 * committed without the parent its FK points at, and both inherit the single
 * `classification_level` the document was ingested under — which is what keeps
 * parent resolution inside the RLS policy rather than around it.
 *
 * Ordering note: parents must sort before their children within the arrays, so
 * the self-referencing FK resolves. insertDocumentWithChunks relies on the
 * caller supplying them that way and asserts it below.
 */
const BULK_UPSERT_SQL = `
  INSERT INTO knowledge_base (
    id, content, metadata, classification_level, embedding, is_parent, parent_id
  )
  SELECT u.id, u.content, u.metadata::jsonb, u.classification_level,
         u.embedding::vector, u.is_parent, u.parent_id
  FROM UNNEST(
    $1::uuid[], $2::text[], $3::text[], $4::int[], $5::text[], $6::boolean[], $7::uuid[]
  ) AS u(
    id, content, metadata, classification_level, embedding, is_parent, parent_id
  )
  ON CONFLICT (id) DO UPDATE
    SET content = EXCLUDED.content,
        metadata = EXCLUDED.metadata,
        classification_level = EXCLUDED.classification_level,
        embedding = EXCLUDED.embedding,
        is_parent = EXCLUDED.is_parent,
        parent_id = EXCLUDED.parent_id
  RETURNING id;
`;

type RetrievedRow = {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  classification_level: AccessLevel;
  similarity: number;
  /** Null for a flat chunk (every row written before migration 004). */
  parent_id?: string | null;
};

function mapRow(row: RetrievedRow): SimilarDocument {
  return {
    id: row.id,
    text: row.content,
    metadata: row.metadata,
    classificationLevel: row.classification_level,
    similarity: Number(row.similarity),
    parentId: row.parent_id ?? null,
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

/**
 * Which retrieval strategy an evaluation arm exercises.
 *
 * The benchmark arms differ ONLY by this value: same corpus, same overfetch,
 * same RLS context, same SQL for each leg. That is what lets a difference
 * between arms be attributed to the strategy rather than to incidental
 * differences in how each arm was wired.
 */
export type RetrievalStrategy = "sparse" | "dense" | "hybrid_rrf";

/**
 * Dense leg — pgvector cosine distance over the HNSW index.
 *
 * `is_parent = false` restricts the search to child chunks (migration 004).
 * Parent rows carry embedding = NULL and would sort last anyway, but excluding
 * them explicitly keeps the predicate the same on both legs and lets the
 * partial index do the work. Pre-004 rows default to is_parent = false, so the
 * existing corpus is unaffected.
 */
const DENSE_SQL = `
  SELECT id, content, metadata, classification_level, parent_id,
         1 - (embedding <=> $1::vector) AS similarity
  FROM knowledge_base
  WHERE is_parent = false
    AND embedding IS NOT NULL
  ORDER BY embedding <=> $1::vector
  LIMIT $2;
`;

/**
 * Builds the lexical leg's search expression from a natural-language question.
 *
 * ## Why this exists
 *
 * The leg used to pass the raw question to websearch_to_tsquery, which joins
 * unquoted terms with AND. A 13-word Hebrew question therefore required a chunk
 * to contain all 13 lexemes, which no chunk does, so the lexical leg returned
 * zero rows for every real query. Two consequences, both measured:
 *
 *   - the sparse arm scored 0.000 on every metric, which looked like poor
 *     Hebrew recall and was actually an empty result set;
 *   - hybrid retrieval silently degraded to dense-only, because
 *     executeRetrieval falls back to the vector rows when the lexical list is
 *     empty. The two arms produced bit-identical numbers.
 *
 * Terms are now joined with OR, so a chunk matching any of them is a candidate
 * and ts_rank_cd ranks by how densely the matches cluster. That is the normal
 * shape of a lexical leg in hybrid retrieval: recall comes from the OR, and
 * precision comes from the ranking and from fusion with the dense leg.
 *
 * Returns null when nothing usable survives tokenisation, so the caller skips
 * the leg instead of issuing a query that cannot match.
 */
const MAX_LEXICAL_TERMS = 24;

/** Words websearch_to_tsquery reads as operators rather than as search terms. */
const TSQUERY_OPERATORS = new Set(["or", "and", "not"]);

/**
 * Tokeniser: extracts terms rather than splitting on punctuation.
 *
 * Splitting broke figures apart. "4,500" became "4" and "500", and "4" was then
 * dropped as a single character, so the term that actually discriminates
 * between the L1 monthly cap (4,500), the fast-track ceiling (2,500) and the
 * per-trip limit (250) was destroyed — precisely the queries where a lexical
 * arm should beat a dense one.
 *
 * A number keeps its internal separators, so "4,500", "03-5550199" and
 * "2026-11-18" survive as single terms. Separators are only kept BETWEEN
 * digits, so a leading dash can never reach websearch_to_tsquery, where it
 * would negate the term.
 */
const TERM_PATTERN = /\p{N}+(?:[.,\-/]\p{N}+)*|\p{L}+/gu;

export function buildLexicalSearchExpression(queryText: string): string | null {
  const terms: string[] = [];
  for (const match of queryText.matchAll(TERM_PATTERN)) {
    const term = match[0];
    // A single letter matches almost everything and adds no signal. A single
    // digit is kept only when it is part of a longer figure, which the pattern
    // already guarantees.
    if (term.length < 2) continue;
    if (TSQUERY_OPERATORS.has(term.toLowerCase())) continue;
    terms.push(term);
  }

  const unique = [...new Set(terms)].slice(0, MAX_LEXICAL_TERMS);
  return unique.length === 0 ? null : unique.join(" OR ");
}

/**
 * Lexical leg — PostgreSQL full-text search.
 *
 * `ts_rank_cd` is coverage-density ranking, NOT Okapi BM25; PostgreSQL FTS has
 * no BM25 implementation. Do not describe this arm as BM25.
 *
 * The 'simple' configuration performs no stemming, and Hebrew attaches the
 * prefixes ו/ב/ל/ה/כ/מ/ש directly to the word, so "בפרוטוקול" does not match the
 * lexeme "פרוטוקול". This structurally caps the lexical arm's recall on Hebrew
 * text. That is a property of the language and the available dictionaries, not a
 * defect to patch out, and it is a large part of why fusion helps here.
 */
const LEXICAL_SQL = `
  SELECT id, content, metadata, classification_level, parent_id,
         ts_rank_cd(content_tsv, websearch_to_tsquery('simple', $1)) AS similarity
  FROM knowledge_base
  WHERE content_tsv @@ websearch_to_tsquery('simple', $1)
    AND is_parent = false
  ORDER BY similarity DESC
  LIMIT $2;
`;

/**
 * The lexical leg distinguishes "matched nothing" from "could not run".
 *
 * Hybrid retrieval treats a broken leg as a reason to fall back on dense rows,
 * which is right for a user-facing request. An evaluation arm must not: a
 * sparse-only arm that silently returned zero rows after a SQL failure would be
 * recorded as having found nothing, and the benchmark would attribute a tooling
 * fault to the retrieval strategy.
 */
type LexicalLegResult =
  | { ok: true; rows: SimilarDocument[] }
  | { ok: false; error: string };

async function runDenseLeg(
  client: PoolClient,
  vectorLiteral: string,
  limit: number
): Promise<SimilarDocument[]> {
  const res = await client.query<RetrievedRow>(DENSE_SQL, [vectorLiteral, limit]);
  return res.rows.map(mapRow);
}

async function runLexicalLeg(
  client: PoolClient,
  queryText: string,
  limit: number
): Promise<LexicalLegResult> {
  const expression = buildLexicalSearchExpression(queryText);
  if (expression === null) {
    // Nothing searchable in the query. Not a failure: an empty result is the
    // correct answer, and the hybrid path will use the dense leg alone.
    return { ok: true, rows: [] };
  }

  try {
    const res = await client.query<RetrievedRow>(LEXICAL_SQL, [expression, limit]);
    return { ok: true, rows: res.rows.map(mapRow) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logWarn("retrieval_lexical_leg_failed", error, {
      sqlPreview: LEXICAL_SQL.slice(0, 120),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { ok: false, error };
  }
}

const PARENT_FETCH_SQL = `
  SELECT id, content, metadata, classification_level, parent_id, 0 AS similarity
  FROM knowledge_base
  WHERE id = ANY($1::uuid[])
    AND is_parent = true;
`;

/**
 * Widens each matched child chunk to its parent's text, then deduplicates.
 *
 * ## Why this runs on the caller's client
 *
 * `client` is the one already inside `withRlsTransaction`, so this SELECT is
 * evaluated as `scholaragent_app` under `app.user_permission_level` exactly
 * like the child search was. A parent is written with the SAME
 * classification_level as its children (migration 004), so the policy
 *
 *     classification_level >= current_setting('app.user_permission_level')::int
 *
 * admits the parent precisely when it admitted the child. Resolving parents on
 * a service client instead would read across every tier and silently convert
 * every retrieval into a leak — that is why this takes a client rather than
 * opening its own.
 *
 * Ordering is preserved: the first (best-ranked) child to name a parent decides
 * that parent's position and keeps its `rrfScore` / `similarity` /
 * `classificationLevel`. Later children of the same parent are dropped, which
 * is the deduplication — several children of one passage would otherwise spend
 * the whole context budget on one document.
 *
 * Fails safe: a child whose parent is missing (or filtered) keeps its own text.
 *
 * Exported so the widening and dedup rules can be tested against a fake client
 * without a database, for the same reason `assertSqlIdentifier` is exported.
 */
export async function resolveParentChunks(
  client: Pick<PoolClient, "query">,
  rows: SimilarDocument[]
): Promise<SimilarDocument[]> {
  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((id): id is string => !!id))];

  // Flat corpus (everything written before migration 004): nothing to widen, so
  // no second round trip is spent.
  if (parentIds.length === 0) {
    return dedupeById(rows);
  }

  const res = await client.query<RetrievedRow>(PARENT_FETCH_SQL, [parentIds]);
  const parents = new Map(res.rows.map((row) => [row.id, row]));

  const widened = rows.map((row) => {
    if (!row.parentId) return row;
    const parent = parents.get(row.parentId);
    if (!parent) {
      // The parent row did not come back. Keep the child verbatim rather than
      // dropping the hit: returning less text is a degradation, returning
      // someone else's text would be a leak.
      logWarn("retrieval_parent_unresolved", "Parent chunk not returned; using child text", {
        childId: row.id,
        parentId: row.parentId,
      });
      return row;
    }
    return {
      ...row,
      id: parent.id,
      text: parent.content,
      metadata: parent.metadata,
      // Taken from the parent row the policy actually returned, not copied from
      // the child, so the value always describes the text being returned.
      classificationLevel: parent.classification_level,
      parentId: null,
      matchedChildId: row.id,
    };
  });

  return dedupeById(widened);
}

/** Keeps the first occurrence of each id, preserving rank order. */
function dedupeById(rows: SimilarDocument[]): SimilarDocument[] {
  const seen = new Set<string>();
  const out: SimilarDocument[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

async function executeRetrieval(
  client: PoolClient,
  queryText: string,
  vectorLiteral: string,
  opts: NormalizedQueryOptions,
  strategy: RetrievalStrategy
): Promise<SimilarDocument[]> {
  const overfetch = opts.overfetch;

  // Each branch produces its ranked CHILD rows. Parent resolution, dedup and
  // the final truncation happen once, below, so all four arms stay on the one
  // code path that makes the benchmark comparable (see CLAUDE.md) and so the
  // limit counts distinct parents rather than pre-dedup children.
  let ranked: SimilarDocument[];

  if (strategy === "dense") {
    ranked = await runDenseLeg(client, vectorLiteral, overfetch);
  } else if (strategy === "sparse") {
    const lexical = await runLexicalLeg(client, queryText, overfetch);
    if (!lexical.ok) {
      // Never degrade to dense here — see LexicalLegResult.
      throw new Error(`Sparse retrieval arm failed: ${lexical.error}`);
    }
    ranked = lexical.rows;
  } else {
    const vectorRows = await runDenseLeg(client, vectorLiteral, overfetch);
    const lexical = await runLexicalLeg(client, queryText, overfetch);

    ranked =
      !lexical.ok || lexical.rows.length === 0
        ? vectorRows
        : reciprocalRankFusion(vectorRows, lexical.rows, opts.rrfK);
  }

  const resolved = await resolveParentChunks(client, ranked);
  return resolved.slice(0, opts.limit);
}

/** Preserved name and behaviour for existing hybrid callers. */
async function executeHybridRetrieval(
  client: PoolClient,
  queryText: string,
  vectorLiteral: string,
  opts: NormalizedQueryOptions
): Promise<SimilarDocument[]> {
  return executeRetrieval(client, queryText, vectorLiteral, opts, "hybrid_rrf");
}

/**
 * RLS-scoped retrieval under an explicit strategy, for the evaluation arms.
 * Shares `executeRetrieval` with the production hybrid path.
 */
export async function querySimilarDocumentsByStrategy(
  queryText: string,
  queryEmbedding: number[],
  permissionLevel: AccessLevel,
  strategy: RetrievalStrategy,
  options?: number | QuerySimilarOptions
): Promise<SimilarDocument[]> {
  const opts = normalizeQueryOptions(options);
  const vectorLiteral = toVectorLiteral(queryEmbedding);
  return withRlsTransaction(permissionLevel, (client) =>
    executeRetrieval(client, queryText, vectorLiteral, opts, strategy)
  );
}

/**
 * Unrestricted retrieval under an explicit strategy. Used to build the
 * annotation candidate pool and as the positive control that proves a seeded
 * canary is reachable at all. Never call this on a user-facing path.
 */
export async function querySimilarDocumentsByStrategyBypassRls(
  queryText: string,
  queryEmbedding: number[],
  strategy: RetrievalStrategy,
  options?: number | QuerySimilarOptions
): Promise<SimilarDocument[]> {
  const opts = normalizeQueryOptions(options);
  const vectorLiteral = toVectorLiteral(queryEmbedding);
  return withServiceClient((client) =>
    executeRetrieval(client, queryText, vectorLiteral, opts, strategy)
  );
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
  /**
   * Pre-computed. Embedding inside the transaction would hold it open for
   * minutes.
   *
   * NULL for a parent row: parents are never searched directly, so the project
   * pays no embedding cost for them (migration 004).
   */
  embedding: number[] | null;
  /**
   * True for a large parent row. Retrieval searches `is_parent = false` only.
   * Omitted means false, so an existing caller keeps writing searchable rows.
   */
  isParent?: boolean;
  /**
   * Index into the same `chunks` array identifying this row's parent, resolved
   * to the parent's generated UUID inside the transaction.
   *
   * An index rather than an id because ids are generated here, not by the
   * caller. Omitted means no parent (a flat chunk, as before migration 004).
   */
  parentIndex?: number | null;
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
  // is ever put into a transaction. A parent row carries no embedding.
  const embeddings = input.chunks.map((c) =>
    c.embedding === null ? null : toVectorLiteral(c.embedding)
  );
  const metadata = input.chunks.map((c) => JSON.stringify(c.metadata));
  const isParentFlags = input.chunks.map((c) => c.isParent === true);

  // parentIndex -> the parent's generated UUID. Validated before BEGIN: a
  // forward or out-of-range reference would otherwise surface as an opaque FK
  // violation mid-transaction, and a self-reference would insert a row that
  // points at itself.
  const parentIds = input.chunks.map((c, i) => {
    const pi = c.parentIndex;
    if (pi === undefined || pi === null) return null;
    if (!Number.isInteger(pi) || pi < 0 || pi >= input.chunks.length) {
      throw new Error(`Chunk ${i} has out-of-range parentIndex ${pi}.`);
    }
    if (pi === i) {
      throw new Error(`Chunk ${i} lists itself as its own parent.`);
    }
    if (pi > i) {
      throw new Error(
        `Chunk ${i} references parentIndex ${pi}, which is inserted later; ` +
          "parents must precede their children."
      );
    }
    if (input.chunks[pi]?.isParent !== true) {
      throw new Error(`Chunk ${i} points at index ${pi}, which is not a parent row.`);
    }
    return chunkIds[pi] ?? null;
  });

  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_permission_level', $1, true)", [
        String(input.writePermissionLevel),
      ]);
      // GUC first, then the role switch (see withRlsTransaction). Without it
      // this write runs as the connecting owner/superuser and every INSERT
      // policy on ingested_documents and knowledge_base is skipped.
      await enterAppRole(client);

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
        isParentFlags,
        parentIds,
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes a document's chunks and its registry row on one client.
 *
 * Both halves matter. Removing only the chunks leaves an `ingested_documents`
 * row with no chunks, which is exactly what `findDocumentsMissingChunks` selects
 * — so `npm run reconcile` would re-embed a document that was deleted or
 * redacted on purpose. The registry row therefore goes too, in the same
 * transaction as the chunks.
 *
 * Chunks are deleted first so the returned count is the number of chunks
 * retracted; the registry delete then fires `trg_ingested_documents_cascade_chunks`
 * over what is already gone (a no-op). Exported so the statement order can be
 * pinned without a database.
 */
export async function deleteDocumentAndChunks(
  client: Pick<PoolClient, "query">,
  documentId: string
): Promise<number> {
  const chunks = await client.query(
    `DELETE FROM knowledge_base WHERE metadata->>'document_id' = $1`,
    [documentId]
  );

  // `id` is a uuid column; a non-UUID string would raise instead of matching
  // nothing, and a non-UUID id cannot be a registry row anyway.
  if (UUID_PATTERN.test(documentId)) {
    await client.query(`DELETE FROM ingested_documents WHERE id = $1::uuid`, [documentId]);
  }

  return chunks.rowCount ?? 0;
}

/**
 * Hard-delete a logical source document: every chunk tagged with
 * metadata.document_id AND its `ingested_documents` registry row, atomically.
 * Call from a trusted webhook after upstream CMS deletion or full redaction.
 *
 * Returns the number of chunks removed.
 */
export async function hardDeleteKnowledgeChunksByDocumentId(documentId: string): Promise<number> {
  const id = documentId.trim();
  if (!id) return 0;
  return withRlsTransaction(MAX_PRIVILEGE_LEVEL, (client) => deleteDocumentAndChunks(client, id));
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
  const embeddings = input.chunks.map((c) =>
    c.embedding === null ? null : toVectorLiteral(c.embedding)
  );
  const metadata = input.chunks.map((c) => JSON.stringify(c.metadata));
  // Reconciliation re-ingests a document as flat searchable chunks, exactly as
  // it did before migration 004. It does not reconstruct a parent/child tree:
  // the rows it repairs were written flat, and inventing parents for them here
  // would change what the retrieval path returns for already-graded documents.
  const isParentFlags = input.chunks.map((c) => c.isParent === true);
  const parentIds = input.chunks.map(() => null);

  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      // Admin level for the same reason as findDocumentsMissingChunks: without it
      // the emptiness re-check below cannot see a single existing chunk.
      await client.query("SELECT set_config('app.user_permission_level', $1, true)", [
        String(MAX_PRIVILEGE_LEVEL),
      ]);
      // Admin tier, but still under the unprivileged role: the policies must
      // evaluate even for the reconciler, or the admin level means nothing.
      await enterAppRole(client);

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
        isParentFlags,
        parentIds,
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
