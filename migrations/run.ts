// Apply pending SQL migrations in filename order.
// Usage: npm run migrate
//
// 001_initial_schema.sql is the consolidated baseline: tables, the
// least-privilege scholaragent_app role and its grants, and all RLS policies.
// Later files (002, 004, 005, ...) are applied after it in filename order.
// Databases that already ran the legacy incremental series (stamped
// 009_rls_tighten) are recorded as 001_initial_schema without re-executing DDL.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { Pool } from "pg";

// Matches scripts/ingest_directory.ts, scripts/reconcile_documents.ts and
// scripts/evaluate_runner.ts. Without this, DATABASE_URL had to be exported by
// hand in the shell even though .env.local already defined it.
dotenv.config({ path: ".env.local" });

// package.json declares no "type", so Node parses this file as ESM — where
// __dirname does not exist — while tsx compiles it to CommonJS, where
// import.meta does not. Resolve under either rather than depending on which
// loader happens to win. The CommonJS branch is tested first so the ESM branch
// is never evaluated under a CJS transform that may stub import.meta.
const SCRIPT_DIR =
  typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));

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

    const files = (await readdir(SCRIPT_DIR)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      const version = file.replace(".sql", "");
      if (applied.has(version)) {
        console.log(`[skip] ${file} — already applied`);
        continue;
      }

      const sql = await readFile(join(SCRIPT_DIR, file), "utf-8");
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
