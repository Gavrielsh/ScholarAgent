/**
 * grade_qrels.ts — apply the grading rubric to ungraded qrels rows.
 *
 * Grades every row whose `grade` is null, using golden_dataset.json as the
 * reference. Rows that already carry a grade are never touched: hand-made
 * judgements outrank anything computed here.
 *
 * ## Why this grades on chunk text, not document text
 *
 * The rubric's distinction between 2 and 1 is "does THIS chunk contain the
 * answer, or does the answer sit in another chunk of the same document". Both
 * available shortcuts destroy that distinction:
 *
 * - `local_data/eval_corpus/<source_path>` is the whole document. Nearly every
 *   chunk of an expected document would score 2, and grade 1 would never occur.
 * - `excerpt` is only the first 400 characters of the chunk, so a figure later
 *   in the same chunk would be missed and scored 1 instead of 2.
 *
 * So the real chunk body is read from knowledge_base by chunk id. RLS is
 * bypassed deliberately: grading must see every tier, and this is an offline
 * annotation tool, not a user-facing path. Pass --no-db to fall back to the
 * excerpt, which biases toward grade 1 and says so in its output.
 *
 * ## Rubric
 *
 *   2  the chunk contains the figures, names or rules from `expected_facts`
 *      that answer the query
 *   1  the chunk is from an expected document but not the part holding the
 *      answer — relevant background
 *   0  the chunk does not contribute
 *
 * A fact counts as present when at least FACT_TOKEN_THRESHOLD of its
 * distinctive tokens (figures, codes, and Hebrew or Latin words of four or more
 * characters) appear in the chunk. Exact substring matching would fail on
 * paraphrase and on markdown emphasis inside the corpus; requiring every token
 * would fail on any rewording at all.
 *
 *   npm run grade:qrels              apply, after writing a timestamped backup
 *   npm run grade:qrels -- --dry-run report only, change nothing
 *   npm run grade:qrels -- --no-db   grade from excerpts (less accurate)
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import dotenv from "dotenv";

import { withServiceClient } from "@/lib/core/db";
import { GOLDEN_BY_ID } from "./data/golden_dataset";
import type { QrelCandidate } from "./data/qrels";

dotenv.config({ path: ".env.local" });

const SCRIPT_DIR =
  typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const QRELS_PATH = path.join(SCRIPT_DIR, "data", "qrels.jsonl");

/** Share of a fact's distinctive tokens that must appear for it to count. */
const FACT_TOKEN_THRESHOLD = 0.6;

/** Words too common to distinguish one fact from another. */
const STOPWORDS = new Set([
  "של","את","עד","לא","או","עם","אין","יש","כל","מה","על","הוא","היא","זה",
  "ליום","לכל","אחת","שני","שתי","הזה","אשר","כדי","גם","רק","בלבד",
]);

function normalise(text: string): string {
  // Collapse whitespace and drop markdown emphasis. The corpus writes figures
  // as **1,000 ש"ח**, and the asterisks survive text extraction.
  return text.replace(/[*_`#]/g, "").replace(/\s+/g, " ");
}

/**
 * A fact's tokens, split by how much they discriminate.
 *
 * Figures and codes carry the answer: "50", "4,500", "CASE-904". Words only
 * support it. The split matters because an earlier version required three or
 * more characters for a number, which silently dropped "50" and reduced the
 * fact `עד 50 ש"ח ליום פעילות` to the single word `פעילות` — a word in nearly
 * every document. Any chunk mentioning activity then scored as a direct answer.
 */
interface FactTokens {
  /**
   * Identifiers such as CASE-904 and TR-4471-A. A unique handle for exactly one
   * record, so one of them appearing is conclusive on its own — a chunk reading
   * "תיק CASE-904 נפתח" answers a question about that case even without
   * repeating the family name.
   */
  codes: string[];
  /** Plain numbers. Every one must appear, since each carries part of the answer. */
  numbers: string[];
  /** Supporting words. A proportion must appear. */
  lexical: string[];
}

function factTokens(fact: string): FactTokens {
  const text = normalise(fact);
  const codes = new Set<string>();
  const numbers = new Set<string>();
  const lexical = new Set<string>();

  for (const m of text.matchAll(/[A-Z][A-Z0-9]*-[\w-]+/g)) codes.add(m[0]);

  // Numbers are scanned with the codes removed, so CASE-904 does not also
  // contribute a bare "904" that would then be required separately.
  const withoutCodes = [...codes].reduce((acc, c) => acc.split(c).join(" "), text);
  for (const m of withoutCodes.matchAll(/\d[\d,]*/g)) numbers.add(m[0]);

  for (const m of text.matchAll(/[\u0590-\u05FF]{3,}/g)) {
    if (!STOPWORDS.has(m[0])) lexical.add(m[0]);
  }
  for (const m of withoutCodes.matchAll(/[A-Za-z]{4,}/g)) lexical.add(m[0]);

  return { codes: [...codes], numbers: [...numbers], lexical: [...lexical] };
}

/**
 * Whether a figure appears in the text as its own number.
 *
 * Boundary-checked so the token "50" does not match inside "350" or
 * "1,850,000" — which would turn the L2 voucher value into a false hit for the
 * travel cap.
 */
function containsFigure(haystack: string, figure: string): boolean {
  const escaped = figure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d,])${escaped}(?![\\d,])`).test(haystack);
}

export interface FactMatch {
  fact: string;
  coverage: number;
  /**
   * "figure" — the fact names a number or code and the chunk has all of them.
   *            Strong evidence the chunk holds the answer.
   * "lexical" — the fact is purely verbal, e.g. "כנגד קבלות". Still a listed
   *            fact, so the rubric counts it, but many chunks of the right
   *            document can satisfy one, which blunts the 1-vs-2 distinction
   *            that graded metrics rely on. --figures-only demotes these to 1.
   */
  kind: "figure" | "lexical";
}

/**
 * The best-covered expected fact for this chunk, or null when none qualify.
 *
 * A fact counts only when every figure it names is present. Without that rule a
 * chunk discussing the right topic in the right document scores as though it
 * held the answer, and grade 1 never occurs.
 */
export function bestFact(chunkText: string, facts: readonly string[]): FactMatch | null {
  const haystack = normalise(chunkText);
  let best: FactMatch | null = null;

  for (const fact of facts) {
    const { codes, numbers, lexical } = factTokens(fact);

    let kind: FactMatch["kind"] | null = null;
    let coverage = 0;

    if (codes.length > 0) {
      // A unique identifier is conclusive on its own.
      if (!codes.every((c) => haystack.includes(c))) continue;
      kind = "figure";
      coverage = 1;
    } else {
      if (numbers.length === 0 && lexical.length < 2) continue;
      if (!numbers.every((n) => containsFigure(haystack, n))) continue;

      const lexHits = lexical.filter((w) => haystack.includes(w)).length;
      const lexCoverage = lexical.length === 0 ? 1 : lexHits / lexical.length;
      if (lexCoverage < FACT_TOKEN_THRESHOLD) continue;
      // A single supporting word with no figure is not evidence of an answer.
      if (numbers.length === 0 && lexHits < 2) continue;

      kind = numbers.length > 0 ? "figure" : "lexical";
      const total = numbers.length + lexical.length;
      coverage = total === 0 ? 0 : (numbers.length + lexHits) / total;
    }

    // A figure-backed match always wins over a purely verbal one, whatever the
    // coverage arithmetic says: it is the stronger evidence of a direct answer.
    const better =
      best === null ||
      (kind === "figure" && best.kind === "lexical") ||
      (kind === best.kind && coverage > best.coverage);
    if (better) best = { fact, coverage, kind };
  }

  return best;
}

export interface ChunkClassification {
  grade: 0 | 1 | 2;
  reason: string;
  matchedFact?: string;
  coverage?: number;
  kind?: FactMatch["kind"];
}

/**
 * The rubric, as a pure function so it can be tested without a database.
 *
 *   2  the chunk contains an expected fact
 *   1  from an expected document, but not the part holding the answer
 *   0  does not contribute
 */
export function classifyChunk(input: {
  chunkText: string;
  expectedFacts: readonly string[];
  inExpectedDoc: boolean;
  figuresOnly?: boolean;
}): ChunkClassification {
  const match = bestFact(input.chunkText, input.expectedFacts);

  if (match && !(input.figuresOnly && match.kind === "lexical")) {
    return {
      grade: 2,
      reason: `chunk contains an expected fact (${match.kind})`,
      matchedFact: match.fact,
      coverage: match.coverage,
      kind: match.kind,
    };
  }

  if (input.inExpectedDoc) {
    return {
      grade: 1,
      reason: match
        ? "expected document; only a verbal fact matched and --figures-only is set"
        : "expected document, answer sits in another chunk",
      matchedFact: match?.fact,
      kind: match?.kind,
    };
  }

  return { grade: 0, reason: "not from an expected document, no expected fact" };
}

interface Decision extends ChunkClassification {
  row: QrelCandidate;
}

async function fetchChunkTexts(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  return withServiceClient(async (client) => {
    const res = await client.query<{ id: string; content: string }>(
      "SELECT id, content FROM knowledge_base WHERE id = ANY($1::uuid[]);",
      [ids]
    );
    return new Map(res.rows.map((r) => [r.id, r.content]));
  });
}

function decide(
  row: QrelCandidate,
  chunkText: string,
  figuresOnly: boolean
): Decision {
  const golden = GOLDEN_BY_ID.get(row.queryId);
  if (!golden) {
    return { row, grade: 0, reason: `no golden record for ${row.queryId}` };
  }
  return {
    row,
    ...classifyChunk({
      chunkText,
      expectedFacts: golden.expected_facts,
      inExpectedDoc: row.in_expected_doc === true,
      figuresOnly,
    }),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const useDb = !argv.includes("--no-db");
  const figuresOnly = argv.includes("--figures-only");

  let raw: string;
  try {
    raw = await readFile(QRELS_PATH, "utf-8");
  } catch {
    console.error(chalk.red(`\n  Cannot read ${QRELS_PATH}`));
    console.error(chalk.bold("  Build the pool first:  npm run qrels:pool\n"));
    process.exit(1);
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const rows: QrelCandidate[] = lines.map((line, i) => {
    try {
      return JSON.parse(line) as QrelCandidate;
    } catch {
      throw new Error(`qrels line ${i + 1} is not valid JSON`);
    }
  });

  const ungraded = rows.filter((r) => r.grade === null || r.grade === undefined);

  console.log(chalk.bold.green("\n  Grading qrels"));
  console.log(`  File     : ${QRELS_PATH}`);
  console.log(`  Rows     : ${rows.length}`);
  console.log(`  Ungraded : ${ungraded.length}`);
  console.log(`  Source   : ${useDb ? "knowledge_base chunk text" : chalk.yellow("excerpt only (--no-db)")}`);
  if (!useDb) {
    console.log(
      chalk.yellow("             excerpt is the first 400 chars of the chunk, so a fact")
    );
    console.log(
      chalk.yellow("             later in the chunk is missed and graded 1 instead of 2")
    );
  }
  console.log(
    `  Grade 2   : ${figuresOnly ? "only figure-backed facts (--figures-only)" : "any expected fact, verbal ones included"}`
  );
  if (dryRun) console.log(chalk.cyan("  Mode     : dry run, nothing will be written"));
  console.log();

  if (ungraded.length === 0) {
    console.log(chalk.green("  Nothing to do: every row already has a grade.\n"));
  }

  let chunkTexts = new Map<string, string>();
  if (useDb && ungraded.length > 0) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set. Put it in .env.local, or pass --no-db.");
    }
    chunkTexts = await fetchChunkTexts(ungraded.map((r) => r.chunkId));
    const missing = ungraded.filter((r) => !chunkTexts.has(r.chunkId)).length;
    console.log(
      `  Fetched ${chunkTexts.size} chunk bodies` +
        (missing > 0
          ? chalk.yellow(`, ${missing} not found in knowledge_base — falling back to excerpt`)
          : "")
    );
    console.log();
  }

  const decisions = ungraded.map((row) =>
    decide(row, chunkTexts.get(row.chunkId) ?? row.excerpt ?? "", figuresOnly)
  );

  for (const d of decisions) {
    d.row.grade = d.grade;
  }

  // ── distribution ─────────────────────────────────────────────────────────
  const dist = rows.reduce<Record<string, number>>((acc, r) => {
    const key = r.grade === null || r.grade === undefined ? "null" : String(r.grade);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  console.log(chalk.bold("  Distribution over all rows"));
  for (const key of ["0", "1", "2", "null"]) {
    if (dist[key] === undefined) continue;
    const colour = key === "null" ? chalk.red : chalk.white;
    console.log(colour(`    grade ${key.padEnd(4)} : ${dist[key]}`));
  }
  console.log(`    total      : ${rows.length}`);
  console.log();

  // ── audit table ──────────────────────────────────────────────────────────
  const assigned2 = decisions.filter((d) => d.grade === 2);
  const assigned1 = decisions.filter((d) => d.grade === 1);
  const assigned0 = decisions.filter((d) => d.grade === 0);

  if (assigned2.length > 0) {
    console.log(chalk.bold(`  Assigned grade 2 — ${assigned2.length} rows`));
    const figureBacked = assigned2.filter((d) => d.kind === "figure").length;
    console.log(
      chalk.dim(`  ${figureBacked} figure-backed, ${assigned2.length - figureBacked} verbal-only`)
    );
    console.log("  query     tier  chunk     evidence cov   document                      matched fact");
    for (const d of assigned2) {
      console.log(
        `  ${d.row.queryId.padEnd(9)} ${(d.row.query_tier ?? "?").padEnd(5)} ` +
          `${d.row.chunkId.slice(0, 8)}  ${(d.kind ?? "?").padEnd(8)} ` +
          `${((d.coverage ?? 0) * 100).toFixed(0).padStart(3)}%  ` +
          `${truncate(d.row.source_path ?? "(none)", 29).padEnd(29)} ${truncate(d.matchedFact ?? "", 42)}`
      );
    }
    console.log();
  }

  if (assigned1.length > 0) {
    console.log(chalk.bold(`  Assigned grade 1 — ${assigned1.length} rows`));
    console.log("  query     tier  chunk     document                          excerpt");
    for (const d of assigned1) {
      console.log(
        `  ${d.row.queryId.padEnd(9)} ${(d.row.query_tier ?? "?").padEnd(5)} ` +
          `${d.row.chunkId.slice(0, 8)}  ${truncate(d.row.source_path ?? "(none)", 33).padEnd(33)} ` +
          `${truncate(d.row.excerpt ?? "", 46)}`
      );
    }
    console.log();
  }

  if (assigned0.length > 0) {
    console.log(chalk.bold(`  Assigned grade 0 — ${assigned0.length} rows`));
    for (const d of assigned0) {
      console.log(
        `  ${d.row.queryId.padEnd(9)} ${d.row.chunkId.slice(0, 8)}  ${d.reason}`
      );
    }
    console.log();
  }

  if (dryRun) {
    console.log(chalk.cyan("  Dry run — qrels.jsonl was not modified.\n"));
    return;
  }

  if (ungraded.length === 0) return;

  // Backup first: this file holds annotation work that cannot be regenerated,
  // because re-pooling produces fresh rows with grade null.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backup = `${QRELS_PATH}.${stamp}.bak`;
  await writeFile(backup, raw, "utf-8");

  // Write via a temporary file and rename, so an interrupted run cannot leave a
  // half-written qrels file as the only copy.
  const tmp = `${QRELS_PATH}.tmp`;
  await writeFile(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  await rename(tmp, QRELS_PATH);

  console.log(chalk.bold.green(`  Wrote ${rows.length} rows.`));
  console.log(`  Backup   : ${backup}`);

  const remaining = rows.filter((r) => r.grade === null || r.grade === undefined).length;
  if (remaining > 0) {
    console.log(chalk.red.bold(`\n  ${remaining} rows still ungraded — benchmark will refuse to run.\n`));
    process.exitCode = 1;
  } else {
    console.log(chalk.green("\n  0 null grades remain. Ready for: npm run benchmark\n"));
  }
}

/**
 * True only when this file is the process entry point.
 *
 * Without this, importing the module to unit-test the rubric would run the
 * whole grader — reading qrels.jsonl, hitting the database and calling
 * process.exit inside the test runner.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self =
    typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
  const strip = (p: string) => path.basename(p).replace(/\.(ts|tsx|js|mjs|cjs)$/, "");
  return path.resolve(entry) === path.resolve(self) || strip(entry) === strip(self);
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(chalk.red("\n  Grading failed:"), err);
    process.exit(1);
  });
}
