// Run all pending SQL migrations in order.
// Usage: npm run migrate
//        (or: npx ts-node migrations/run.ts)

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }

  const pool = new Pool({ connectionString });

  try {
    // Ensure the tracking table exists before we query it.
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

    const dir = join(__dirname);
    const files = (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

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
