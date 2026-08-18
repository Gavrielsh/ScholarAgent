import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type { PermissionLevel } from "@/lib/auth/types";
import { logError } from "@/lib/logger";
import { parseNonNegativeInt, parsePositiveInt } from "@/lib/queue/jobRuntime";

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
export function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

/**
 * Pool for DLS evaluation and other admin paths. Uses DATABASE_SERVICE_URL when set
 * (role should bypass RLS or own the table); otherwise falls back to DATABASE_URL.
 */
export function getServicePool(): Pool {
  if (!servicePool) {
    servicePool = createServicePool();
  }
  return servicePool;
}

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
  permissionLevel: PermissionLevel,
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

/** Constraint name behind a 23505, when the driver reported one. */
export function uniqueViolationConstraint(err: unknown): string | null {
  const constraint = asPostgresError(err)?.constraint;
  return typeof constraint === "string" ? constraint : null;
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
    throw errors[0];
  }
}