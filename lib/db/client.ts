import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type { PermissionLevel } from "@/lib/auth/types";

// TODO: The "pg" package is not yet listed in package.json. Add it via:
//       npm install pg && npm install -D @types/pg

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Missing DATABASE_URL environment variable.");
  }

  pool = new Pool({
    connectionString,
    // Supabase transaction pooler works best with short-lived pooled sessions.
    max: Number(process.env.PG_POOL_MAX ?? 5),
    min: Number(process.env.PG_POOL_MIN ?? 1),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.PG_SSLMODE === "disable" ? false : { rejectUnauthorized: false },
    keepAlive: true,
    allowExitOnIdle: true,
  });

  pool.on("error", (err) => {
    // TODO: Wire structured logging / observability (e.g. Pino, OpenTelemetry).
    console.error("Postgres pool error:", err);
  });

  return pool;
}

// Runs a callback with a checked-out client. Always releases the client,
// even on error. Use this for one-shot queries.
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// Runs a callback inside a transaction with the RLS session variable set.
// PostgreSQL RLS policies read `current_setting('app.user_permission_level')`
// to determine row visibility, so every authorised query must run inside
// a transaction that has set this local variable.
export async function withRlsTransaction<T>(
  permissionLevel: PermissionLevel,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      // SET LOCAL is scoped to the current transaction, so concurrent transactions
      // on other connections are unaffected.
      await client.query("SELECT set_config('app.user_permission_level', $1, true)", [
        String(permissionLevel),
      ]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr) => {
        console.error("RLS Transaction Rollback Error:", rollbackErr);
      });
      throw err;
    }
  });
}

// Convenience wrapper around pool.query for queries that don't require RLS scoping.
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as never);
}

// Graceful shutdown — call from process signal handlers.
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
