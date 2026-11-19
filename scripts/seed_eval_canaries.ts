/**
 * seed_eval_canaries.ts — plant the canary corpus and prove it is detectable.
 *
 * ## Why this script is a precondition, not a convenience
 *
 * A canary that is not in the database can never appear in an answer, so a
 * leakage rate measured against absent canaries is 0.00 by construction. It is a
 * test that cannot fail, and reporting it as evidence that RLS contains the
 * model would be a false guarantee. This script plants the strings and then runs
 * two controls:
 *
 * - **Positive control.** With RLS bypassed, retrieval for each canary's probe
 *   query must return the seeded chunk. If it does not, the canary is
 *   unreachable and a later 0% leakage result proves nothing about RLS — it only
 *   shows retrieval never found the material in the first place.
 * - **Negative control.** Under a tier below the canary's classification, the
 *   same retrieval must NOT return it. This is the RLS assertion itself.
 *
 * The script exits non-zero if either control fails, so a broken setup cannot be
 * mistaken for a passing benchmark.
 *
 * Every chunk is written with metadata.eval_corpus = true at a deterministic id
 * derived from the canary string, so re-running updates in place and
 * `--purge` removes exactly these rows and nothing else.
 *
 *   npm run eval:seed
 *   npm run eval:seed -- --purge
 *
 * Requires DATABASE_URL and GEMINI_API_KEY.
 */

import { createHash } from "node:crypto";
import chalk from "chalk";
import dotenv from "dotenv";

import { withServiceClient } from "@/lib/core/db";
import { embedText } from "@/lib/domain/ingestion/embeddings";
import {
  querySimilarDocumentsByStrategy,
  querySimilarDocumentsByStrategyBypassRls,
} from "@/lib/core/db";
import { CANARY_SEEDS, type CanarySeed } from "./data/leakage_specs";
import type { PermissionLevel } from "@/lib/security/auth";

dotenv.config({ path: ".env.local" });

const EVAL_CORPUS_FLAG = "eval_corpus";

/**
 * Deterministic UUIDv5-shaped id from the canary string, so seeding is
 * idempotent and purging can target exactly these rows.
 */
function canaryChunkId(canary: string): string {
  const h = createHash("sha256").update(`scholaragent-eval-canary:${canary}`).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    // version nibble 5, variant bits 10xx — a well-formed UUID, not a random hex blob
    "5" + h.slice(13, 16),
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

const UPSERT_SQL = `
  INSERT INTO knowledge_base (id, content, metadata, classification_level, embedding)
  VALUES ($1::uuid, $2, $3::jsonb, $4, $5::vector)
  ON CONFLICT (id) DO UPDATE
    SET content = EXCLUDED.content,
        metadata = EXCLUDED.metadata,
        classification_level = EXCLUDED.classification_level,
        embedding = EXCLUDED.embedding
  RETURNING id;
`;

async function purge(): Promise<number> {
  const ids = CANARY_SEEDS.map((s) => canaryChunkId(s.canary));
  return withServiceClient(async (client) => {
    const res = await client.query(
      `DELETE FROM knowledge_base
       WHERE id = ANY($1::uuid[]) AND metadata->>'${EVAL_CORPUS_FLAG}' = 'true';`,
      [ids]
    );
    return res.rowCount ?? 0;
  });
}

async function seedOne(seed: CanarySeed): Promise<string> {
  const id = canaryChunkId(seed.canary);
  const embedding = await embedText(seed.content);
  if (embedding.length === 0) {
    throw new Error(`Embedding failed for canary ${seed.canary}; cannot seed.`);
  }

  const metadata = JSON.stringify({
    [EVAL_CORPUS_FLAG]: true,
    canary: seed.canary,
    note: "Synthetic evaluation chunk. Not organisational content. Safe to delete.",
  });

  await withServiceClient((client) =>
    client.query(UPSERT_SQL, [
      id,
      seed.content,
      metadata,
      seed.classificationLevel,
      `[${embedding.join(",")}]`,
    ])
  );
  return id;
}

interface ControlOutcome {
  canary: string;
  level: number;
  positivePassed: boolean;
  negativePassed: boolean;
  negativeTier: PermissionLevel | null;
}

/**
 * Positive control: bypassing RLS must surface the canary chunk.
 * Negative control: a tier numerically above (less privileged than) the chunk's
 * classification must not.
 */
async function runControls(seed: CanarySeed): Promise<ControlOutcome> {
  const id = canaryChunkId(seed.canary);
  // Probe with the canary's own chunk text, the strongest possible query. If
  // even this does not retrieve it, the chunk is simply not reachable.
  const vector = await embedText(seed.content);
  const opts = { limit: 10, overfetch: 200 };

  const bypass = await querySimilarDocumentsByStrategyBypassRls(
    seed.canary,
    vector,
    "hybrid_rrf",
    opts
  );
  const positivePassed = bypass.some((d) => d.id === id);

  // A canary at L3 has no less-privileged tier to test against.
  const negativeTier: PermissionLevel | null =
    seed.classificationLevel < 3 ? ((seed.classificationLevel + 1) as PermissionLevel) : null;

  let negativePassed = true;
  if (negativeTier !== null) {
    const scoped = await querySimilarDocumentsByStrategy(
      seed.canary,
      vector,
      negativeTier,
      "hybrid_rrf",
      opts
    );
    negativePassed = !scoped.some((d) => d.id === id);
  }

  return {
    canary: seed.canary,
    level: seed.classificationLevel,
    positivePassed,
    negativePassed,
    negativeTier,
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Put it in .env.local.");
  }

  if (process.argv.includes("--purge")) {
    const removed = await purge();
    console.log(chalk.bold.green(`\n  Purged ${removed} evaluation canary chunk(s).\n`));
    return;
  }

  console.log(chalk.bold.green("\n  Seeding evaluation canary corpus"));
  console.log(`  Canaries: ${CANARY_SEEDS.length}\n`);

  for (const seed of CANARY_SEEDS) {
    const id = await seedOne(seed);
    console.log(
      chalk.gray(`  seeded L${seed.classificationLevel}  `) +
        chalk.white(seed.canary.padEnd(28)) +
        chalk.dim(id)
    );
  }

  console.log(chalk.bold("\n  Controls\n"));
  const outcomes: ControlOutcome[] = [];
  for (const seed of CANARY_SEEDS) {
    const outcome = await runControls(seed);
    outcomes.push(outcome);

    const pos = outcome.positivePassed ? chalk.green("reachable") : chalk.red("UNREACHABLE");
    const neg =
      outcome.negativeTier === null
        ? chalk.dim("n/a (L3)")
        : outcome.negativePassed
          ? chalk.green(`blocked at L${outcome.negativeTier}`)
          : chalk.red(`LEAKED to L${outcome.negativeTier}`);

    console.log(`  ${outcome.canary.padEnd(28)} positive: ${pos}   negative: ${neg}`);
  }

  const unreachable = outcomes.filter((o) => !o.positivePassed);
  const leaked = outcomes.filter((o) => !o.negativePassed);

  console.log();
  if (unreachable.length > 0) {
    console.log(
      chalk.red.bold(`  ✗ ${unreachable.length} canary/canaries are NOT retrievable.`)
    );
    console.log(
      chalk.red(
        "    A leakage rate measured now would be 0% because retrieval cannot reach\n" +
          "    the material at all — not because access control held. Do not report it."
      )
    );
  }
  if (leaked.length > 0) {
    console.log(
      chalk.red.bold(`  ✗ ${leaked.length} canary/canaries reached a lower-privileged tier.`)
    );
    console.log(
      chalk.red("    This is an RLS enforcement failure and is a finding in its own right.")
    );
  }

  if (unreachable.length === 0 && leaked.length === 0) {
    console.log(chalk.bold.green("  ✓ Both controls passed. Leakage measurement is meaningful."));
    console.log(chalk.dim("    Remove with: npm run eval:seed -- --purge\n"));
    return;
  }

  process.exitCode = 1;
}

main().catch((err) => {
  console.error(chalk.red("\n  Canary seeding failed:"), err);
  process.exit(1);
});
