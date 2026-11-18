/**
 * golden_dataset.ts — typed loader for the corpus-aligned golden dataset.
 *
 * The queries themselves live in golden_dataset.json, which is the single
 * source of truth and is version-controlled alongside the corpus it was written
 * against. This module validates that file at load and exposes two views of it:
 *
 *   GOLDEN_QUERIES  — the rich records, with per-query document and term
 *                     expectations used by the leakage checks.
 *   GOLDEN_DATASET  — the same records shaped as EvalRecord, so
 *                     build_qrels_pool.ts, benchmark_retrieval.ts and
 *                     evaluate_runner.ts keep working unchanged.
 *
 * Every query is grounded in local_data/eval_corpus. The two are a matched
 * pair: editing the corpus without re-checking the dataset silently invalidates
 * both the expectations and the forbidden-term guards.
 */

import type { PermissionLevel } from "@/lib/security/auth";
// Imported with an explicit .json extension. This module and the data file
// share a basename, so a consumer's extensionless "./data/golden_dataset"
// could in principle resolve to the JSON instead of here. tsc (moduleResolution
// "bundler") and tsx both prefer the .ts, and if that ever flips the import
// fails immediately with "does not provide an export named GOLDEN_DATASET"
// rather than silently yielding the wrong shape.
import rawDataset from "./golden_dataset.json";

export type GoldenCategory =
  | "standard_ir"
  | "canary_extraction"
  | "semantic_collision"
  | "privilege_escalation";

export type TierLabel = "L0" | "L1" | "L2";

export interface GoldenQuery {
  id: string;
  category: GoldenCategory;
  /** Clearance the query is asked under. */
  user_tier: TierLabel;
  query: string;
  /**
   * Corpus-relative paths that MUST be retrieved, e.g. "L2/03_...md".
   * Empty for out-of-tier attacks, where retrieving nothing is the correct
   * outcome — not a retrieval failure.
   */
  expected_doc_filenames: string[];
  /** Higher-tier paths that must never be retrieved at `user_tier`. */
  forbidden_doc_filenames: string[];
  /** Facts a grounded answer should contain. Phrased for a reader, so these
   *  are not guaranteed to be verbatim corpus substrings. */
  expected_facts: string[];
  /** Exact strings from higher tiers that must never appear in a chunk or an
   *  answer. These are the leakage canaries, and unlike seeded canaries they
   *  already exist in the corpus at their own tier. */
  forbidden_terms: string[];
}

const TIER_TO_LEVEL: Record<TierLabel, PermissionLevel> = { L0: 0, L1: 1, L2: 2 };

export function tierToPermissionLevel(tier: TierLabel): PermissionLevel {
  return TIER_TO_LEVEL[tier];
}

const CATEGORIES: readonly GoldenCategory[] = [
  "standard_ir",
  "canary_extraction",
  "semantic_collision",
  "privilege_escalation",
];

/**
 * Validates at module load and throws rather than returning partial data.
 *
 * A malformed record would not fail loudly downstream: a missing user_tier
 * would default a query to some tier and quietly measure the wrong thing, and a
 * dropped forbidden_terms array would turn a leakage guard into a check that
 * always passes. Both produce plausible numbers, which is worse than a crash.
 */
function validate(input: unknown): GoldenQuery[] {
  if (!Array.isArray(input)) {
    throw new Error("golden_dataset.json must contain an array of queries.");
  }

  const seen = new Set<string>();
  return input.map((entry, i) => {
    const r = entry as Partial<GoldenQuery>;
    const where = `golden_dataset.json[${i}]`;

    if (typeof r.id !== "string" || r.id.length === 0) {
      throw new Error(`${where} has no id.`);
    }
    if (seen.has(r.id)) throw new Error(`${where}: duplicate id ${r.id}.`);
    seen.add(r.id);

    if (!CATEGORIES.includes(r.category as GoldenCategory)) {
      throw new Error(`${r.id}: unknown category ${JSON.stringify(r.category)}.`);
    }
    if (!(r.user_tier === "L0" || r.user_tier === "L1" || r.user_tier === "L2")) {
      throw new Error(`${r.id}: user_tier must be L0, L1 or L2; got ${JSON.stringify(r.user_tier)}.`);
    }
    if (typeof r.query !== "string" || r.query.trim().length === 0) {
      throw new Error(`${r.id}: empty query.`);
    }

    for (const key of [
      "expected_doc_filenames",
      "forbidden_doc_filenames",
      "expected_facts",
      "forbidden_terms",
    ] as const) {
      const value = r[key];
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new Error(`${r.id}: ${key} must be an array of strings.`);
      }
    }

    const overlap = (r.expected_doc_filenames as string[]).filter((f) =>
      (r.forbidden_doc_filenames as string[]).includes(f)
    );
    if (overlap.length > 0) {
      throw new Error(`${r.id}: ${overlap.join(", ")} is both expected and forbidden.`);
    }

    return r as GoldenQuery;
  });
}

export const GOLDEN_QUERIES: readonly GoldenQuery[] = validate(rawDataset);

// ─────────────────────────────────────────────────────────────────────────────
// EvalRecord view — backwards compatibility for the existing runners
// ─────────────────────────────────────────────────────────────────────────────

export type QueryCategory = "standard" | "adversarial";

export interface EvalRecord {
  id: string;
  question: string;
  /**
   * Fact list, not a reference answer.
   *
   * RAGAS context-recall compares retrieved context against this string. A
   * joined list of facts is a weaker reference than prose: faithfulness and
   * answer-relevancy remain meaningful, but recall against a fact list will
   * read lower than against a full reference answer for the same retrieval.
   * Report it as such rather than comparing it to published RAGAS figures.
   */
  groundTruthAnswer: string;
  expectedContextHints?: string[];
  userRole: PermissionLevel;
  category: QueryCategory;
  expectedContextSegments: string[];
  /** The full record, for consumers that need the document and term guards. */
  golden: GoldenQuery;
}

function toEvalRecord(q: GoldenQuery): EvalRecord {
  return {
    id: q.id,
    question: q.query,
    groundTruthAnswer: q.expected_facts.join("; "),
    expectedContextHints: q.expected_facts,
    userRole: tierToPermissionLevel(q.user_tier),
    category: q.category === "standard_ir" ? "standard" : "adversarial",
    expectedContextSegments: q.expected_doc_filenames,
    golden: q,
  };
}

export const GOLDEN_DATASET: EvalRecord[] = GOLDEN_QUERIES.map(toEvalRecord);

/** Lookup by id, for consumers holding only an EvalRecord's id. */
export const GOLDEN_BY_ID: ReadonlyMap<string, GoldenQuery> = new Map(
  GOLDEN_QUERIES.map((q) => [q.id, q])
);

/**
 * Corpus-relative path of a retrieved chunk, or null when it did not come from
 * the evaluation corpus.
 *
 * ingest_directory.ts stores the path in metadata.source_path via extraMetadata,
 * which pipeline.ts spreads onto every chunk. It is produced by path.relative,
 * so on Windows the separator is a backslash — normalised here, because a
 * dataset written with forward slashes would otherwise match nothing at all on
 * the machine the benchmark actually runs on.
 */
export function chunkSourcePath(metadata: Record<string, unknown> | null): string | null {
  const raw = metadata?.source_path;
  return typeof raw === "string" ? raw.replace(/\\/g, "/") : null;
}
