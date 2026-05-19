import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type { PermissionLevel } from "@/lib/auth/types";
import { logError } from "@/lib/logger";

let pool: Pool | null = null;

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

/** Lazily initialized singleton pool — safe for serverless warm instances. */
export function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

/**
 * Runs a callback with a checked-out client. Always releases the client in `finally`,
 * including on connection errors, to avoid pool starvation.
 */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient | null = null;
  try {
    client = await getPool().connect();
    return await fn(client);
  } catch (err) {
    logError("postgres_with_client_error", err);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
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
}
