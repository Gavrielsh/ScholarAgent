import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type { PermissionLevel } from "@/lib/auth/types";
import { logError } from "@/lib/logger";

let pool: Pool | null = null;
let servicePool: Pool | null = null;

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Missing DATABASE_URL environment variable.");
  }

  const instance = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 5),
    min: Number(process.env.PG_POOL_MIN ?? 1),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PG_SSLMODE === "disable" ? false : { rejectUnauthorized: false },
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
  const connectionString = process.env.DATABASE_SERVICE_URL?.trim() || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Missing DATABASE_SERVICE_URL or DATABASE_URL for service-role access.");
  }

  const instance = new Pool({
    connectionString,
    max: Number(process.env.PG_SERVICE_POOL_MAX ?? 3),
    min: Number(process.env.PG_SERVICE_POOL_MIN ?? 0),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PG_SSLMODE === "disable" ? false : { rejectUnauthorized: false },
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

export async function closePool(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
    } catch (err) {
      logError("postgres_pool_close_error", err);
      throw err;
    } finally {
      pool = null;
    }
  }
  if (servicePool) {
    try {
      await servicePool.end();
    } catch (err) {
      logError("postgres_service_pool_close_error", err);
      throw err;
    } finally {
      servicePool = null;
    }
  }
}
