// Apply pending SQL migrations in filename order.
// Usage: npm run migrate
//
// After schema consolidation the only file is 001_initial_schema.sql — the
// production schema formerly reached by incremental patches 001–009.
// Fresh databases apply that baseline once. Databases that already ran the
// incremental series (stamped 009_rls_tighten) are recorded as
// 001_initial_schema without re-executing DDL.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

const CANONICAL_VERSION = "001_initial_schema";
const LEGACY_BASELINE_MARKER = "009_rls_tighten";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }

  const pool = new Pool({ connectionString });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version;"
    );
    const applied = new Set(rows.map((r) => r.version));

    // Already at the post-009 production schema via the old incremental files.
    if (!applied.has(CANONICAL_VERSION) && applied.has(LEGACY_BASELINE_MARKER)) {
      await pool.query(
        `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING;`,
        [CANONICAL_VERSION]
      );
      applied.add(CANONICAL_VERSION);
      console.log(
        `[stamp] ${CANONICAL_VERSION} — database already at consolidated baseline`
      );
    }

    const dir = join(__dirname);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      const version = file.replace(".sql", "");
      if (applied.has(version)) {
        console.log(`[skip] ${file} — already applied`);
        continue;
      }

      const sql = await readFile(join(dir, file), "utf-8");
      console.log(`[run]  ${file}`);
      await pool.query(sql);
      console.log(`[done] ${file}`);
    }

    console.log("All migrations complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
