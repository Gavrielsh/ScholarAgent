/**
 * build_qrels_pool.ts — build the annotation pool for the retrieval benchmark.
 *
 * Runs all four retrieval arms over every golden-dataset query with RLS
 * BYPASSED, takes the union of what they return, and writes one candidate per
 * line to scripts/data/qrels.jsonl with `grade: null` for a human to fill in.
 *
 * RLS is bypassed deliberately. Pooling under a tier would truncate the relevant
 * set to what that tier can see, and recall would then be measured against a
 * set that varies by query — making arms incomparable. The pool spans every
 * classification level; the *benchmark* runs under each tier.
 *
 * Re-running merges: existing grades are preserved and only genuinely new
 * candidates are appended with `grade: null`. Annotation work is never lost.
 *
 *   npm run qrels:pool
 *   npm run qrels:pool -- --depth 30
 *
 * Requires DATABASE_URL and GEMINI_API_KEY (queries must be embedded).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import dotenv from "dotenv";

import { embedQueryOnce, poolCandidates, ARM_IDS } from "@/lib/domain/ingestion/retrievalArms";
import { GOLDEN_DATASET } from "./data/golden_dataset";
import type { QrelCandidate } from "./data/qrels";

dotenv.config({ path: ".env.local" });

// package.json declares no "type", so Node parses this as ESM (no __dirname)
// while tsx compiles it to CommonJS (no import.meta). Support both.
const SCRIPT_DIR =
  typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

const QRELS_PATH = path.join(SCRIPT_DIR, "data", "qrels.jsonl");
const DEFAULT_POOL_DEPTH = 20;
const EXCERPT_CHARS = 400;

function parseDepth(argv: string[]): number {
  const i = argv.indexOf("--depth");
  if (i === -1) return DEFAULT_POOL_DEPTH;
  const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--depth needs a positive integer, got ${JSON.stringify(argv[i + 1])}`);
  }
  return parsed;
}

/** Existing grades, keyed "queryId\u0000chunkId", so a re-run cannot lose them. */
async function loadExistingGrades(): Promise<Map<string, QrelCandidate>> {
  const existing = new Map<string, QrelCandidate>();
  let raw: string;
  try {
    raw = await readFile(QRELS_PATH, "utf-8");
  } catch {
    return existing;
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as QrelCandidate;
    existing.set(`${parsed.queryId}\u0000${parsed.chunkId}`, parsed);
  }
  return existing;
}

async function main(): Promise<void> {
  const depth = parseDepth(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Put it in .env.local.");
  }

  console.log(chalk.bold.green("\n  Building qrels annotation pool"));
  console.log(`  Queries    : ${GOLDEN_DATASET.length}`);
  console.log(`  Arms       : ${ARM_IDS.join(", ")}`);
  console.log(`  Pool depth : ${depth} per arm (union, RLS bypassed)\n`);

  const existing = await loadExistingGrades();
  if (existing.size > 0) {
    const judged = [...existing.values()].filter((c) => c.grade !== null).length;
    console.log(chalk.cyan(`  Merging with existing pool: ${existing.size} rows, ${judged} already judged\n`));
  }

  const rows: QrelCandidate[] = [];
  let newCandidates = 0;
  let unretrievable = 0;

  for (const [idx, record] of GOLDEN_DATASET.entries()) {
    process.stdout.write(
      chalk.gray(`  [${String(idx + 1).padStart(2)}/${GOLDEN_DATASET.length}] ${record.id} … `)
    );

    const embedded = await embedQueryOnce(record.question);
    if (!embedded) {
      unretrievable++;
      console.log(chalk.yellow("skipped (query produced no embedding)"));
      continue;
    }

    // R4's judge is intentionally omitted here: the pool only needs the
    // candidate set, and calling an LLM per query would make pooling cost money
    // and vary between runs. Without a judge R4 falls back to R3's ordering,
    // which contributes the same candidate ids.
    const pool = await poolCandidates(embedded, {
      limit: depth,
      poolDepth: depth,
      permissionLevel: "bypass",
    });

    for (const [chunkId, { doc, ranks }] of pool) {
      const key = `${record.id}\u0000${chunkId}`;
      const prior = existing.get(key);
      rows.push({
        queryId: record.id,
        chunkId,
        grade: prior?.grade ?? null,
        classificationLevel: doc.classificationLevel,
        arms: ranks,
        excerpt: doc.text.slice(0, EXCERPT_CHARS).replace(/\s+/g, " ").trim(),
      });
      if (!prior) newCandidates++;
    }

    console.log(chalk.green(`${pool.size} candidates`));
  }

  await mkdir(path.dirname(QRELS_PATH), { recursive: true });
  await writeFile(QRELS_PATH, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");

  const judged = rows.filter((r) => r.grade !== null).length;
  const pending = rows.length - judged;

  console.log(chalk.bold.green("\n  Pool written."));
  console.log(`  File            : ${QRELS_PATH}`);
  console.log(`  Total rows      : ${rows.length}`);
  console.log(`  New this run    : ${newCandidates}`);
  console.log(`  Already judged  : ${judged}`);
  console.log(chalk.bold(`  Awaiting grades : ${pending}`));
  if (unretrievable > 0) {
    console.log(chalk.yellow(`  Queries skipped : ${unretrievable} (no embedding)`));
  }

  console.log(
    [
      "",
      "  Next: set every \"grade\" to 0, 1 or 2.",
      "    0 — irrelevant to the question",
      "    1 — partially relevant / related background",
      "    2 — directly answers the question",
      "",
      chalk.dim("  Metrics will refuse to run while any grade is still null: an unjudged"),
      chalk.dim("  chunk counts as irrelevant, which penalises arms unequally depending"),
      chalk.dim("  on which unjudged chunks each one happens to favour."),
      "",
    ].join("\n")
  );
}

main().catch((err) => {
  console.error(chalk.red("\n  Failed to build qrels pool:"), err);
  process.exit(1);
});
