/**
 * benchmark_retrieval.ts — unconfounded retrieval benchmark for the thesis.
 *
 * ## Experiment 1 — retrieval quality
 *
 * Four arms over one shared corpus, differing by exactly one factor (the
 * retrieval strategy). Recall@3/5/10, MRR and NDCG@5 against hand-annotated
 * graded judgements, plus P50/P95 retrieval latency.
 *
 * ## Experiment 2 — cross-tier leakage
 *
 * For every query, under its own permission tier, does any arm return a chunk
 * classified above that tier? This needs no LLM: it is a direct check on
 * whether sparse, dense or fused retrieval can bypass row-level security. It is
 * deterministic and decisive, which is why it runs unconditionally.
 *
 * Generation-stage leakage — whether the model repeats what retrieval handed it
 * — is a separate measurement and lives in evaluate_runner.ts, which has the
 * generation path and the canary specs.
 *
 * ## On repeated runs
 *
 * Arms R1–R3 are deterministic SQL over a fixed corpus: repeats return
 * identical rankings, so their quality metrics have standard deviation exactly
 * 0, and that is a statement about determinism, not reliability. Genuine
 * variance lives in latency, and in R4 when an LLM re-ranker is configured. The
 * report labels zero-variance cells so they are not read as tight confidence.
 *
 *   npm run benchmark
 *   npm run benchmark -- --repeats 5 --allow-partial-qrels
 *
 * Requires DATABASE_URL and GEMINI_API_KEY. The R4 re-ranking judge is the
 * LLM_PROVIDER adapter — the same provider that generates answers, so R4 is
 * exposed to self-preference bias (see lib/domain/chat/rerank.ts).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import dotenv from "dotenv";

import {
  meanStd,
  ndcgAtK,
  percentile,
  recallAtK,
  reciprocalRank,
  type MeanStd,
  type RelevanceGrade,
} from "@/lib/core/irMetrics";
import { computeDls } from "@/lib/core/telemetry";
import { getLlmAdapter } from "@/lib/domain/chat/llm";
import {
  ARM_IDS,
  ARM_LABELS,
  embedQueryOnce,
  runArm,
  RRF_K,
  STAGE1_LIMIT,
  type ArmId,
  type EmbeddedQuery,
} from "@/lib/domain/ingestion/retrievalArms";
import { PERMISSION_ROLE } from "@/lib/security/auth";
import { GOLDEN_DATASET, type EvalRecord } from "./data/golden_dataset";
import { annotationIsComplete, loadQrels, NO_JUDGEMENTS, type QrelsLoadResult } from "./data/qrels";

dotenv.config({ path: ".env.local" });

const SCRIPT_DIR =
  typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(SCRIPT_DIR, "output");
const QRELS_PATH = path.join(SCRIPT_DIR, "data", "qrels.jsonl");

/** Deepest cutoff reported, so one retrieval serves @3, @5 and @10. */
const RETRIEVAL_LIMIT = 10;
const RECALL_CUTOFFS = [3, 5, 10] as const;
const NDCG_CUTOFF = 5;
const DEFAULT_REPEATS = 3;

function intFlag(argv: string[], flag: string, fallback: number): number {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} needs a positive integer, got ${JSON.stringify(argv[i + 1])}`);
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-observation record
// ─────────────────────────────────────────────────────────────────────────────

interface Observation {
  arm: ArmId;
  queryId: string;
  repeat: number;
  retrievedIds: string[];
  recall: Record<number, number>;
  mrr: number;
  ndcg: number;
  retrievalLatencyMs: number;
  rerankLatencyMs: number | null;
  rerankFellBack: boolean | null;
  /** Chunks returned that sit above the asking tier. Should always be 0. */
  unauthorizedChunks: number;
  totalChunks: number;
  error: string | null;
}

async function observe(
  arm: ArmId,
  record: EvalRecord,
  embedded: EmbeddedQuery,
  repeat: number,
  judgements: ReadonlyMap<string, RelevanceGrade>,
  useJudge: boolean
): Promise<Observation> {
  const base = {
    arm,
    queryId: record.id,
    repeat,
    retrievedIds: [] as string[],
    recall: {} as Record<number, number>,
    mrr: NaN,
    ndcg: NaN,
    retrievalLatencyMs: NaN,
    rerankLatencyMs: null as number | null,
    rerankFellBack: null as boolean | null,
    unauthorizedChunks: 0,
    totalChunks: 0,
    error: null as string | null,
  };

  try {
    const result = await runArm(arm, embedded, {
      limit: RETRIEVAL_LIMIT,
      permissionLevel: record.userRole,
      judgeFactory: arm === "R4_hybrid_reranked" && useJudge ? getLlmAdapter : undefined,
      // Vary presentation order per repeat so R4's position bias shows up as
      // variance rather than hiding behind a fixed ordering.
      shuffleSeed: arm === "R4_hybrid_reranked" ? repeat : undefined,
    });

    const ids = result.docs.map((d) => d.id);
    const recall: Record<number, number> = {};
    for (const k of RECALL_CUTOFFS) {
      recall[k] = recallAtK(ids, judgements, k);
    }

    // Cross-tier check. computeDls counts chunks whose classification is more
    // privileged than the asking tier; under correct RLS this is always 0.
    const dls = computeDls(
      { permissionLevel: record.userRole },
      result.docs.map((d) => ({ classificationLevel: d.classificationLevel }))
    );

    return {
      ...base,
      retrievedIds: ids,
      recall,
      mrr: reciprocalRank(ids, judgements),
      ndcg: ndcgAtK(ids, judgements, NDCG_CUTOFF),
      retrievalLatencyMs: result.retrievalLatencyMs,
      rerankLatencyMs: result.rerankLatencyMs ?? null,
      rerankFellBack: result.rerank?.fellBack ?? null,
      unauthorizedChunks: dls.unauthorizedChunks,
      totalChunks: dls.totalChunks,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────────────

interface ArmSummary {
  arm: ArmId;
  label: string;
  observations: number;
  errors: number;
  recall: Record<number, MeanStd>;
  mrr: MeanStd;
  ndcg: MeanStd;
  latencyP50: number;
  latencyP95: number;
  rerankLatencyP50: number | null;
  rerankFallbacks: number;
  /** Observations where a chunk above the asking tier was returned. */
  leakingObservations: number;
  unauthorizedChunksTotal: number;
  /** Share of observations that leaked, as a rate in [0, 1]. */
  crossTierLeakageRate: number;
}

function summarise(arm: ArmId, obs: Observation[]): ArmSummary {
  const ok = obs.filter((o) => o.error === null);

  const recall: Record<number, MeanStd> = {};
  for (const k of RECALL_CUTOFFS) {
    recall[k] = meanStd(ok.map((o) => o.recall[k]));
  }

  const rerankLatencies = ok
    .map((o) => o.rerankLatencyMs)
    .filter((v): v is number => v !== null);

  return {
    arm,
    label: ARM_LABELS[arm],
    observations: obs.length,
    errors: obs.length - ok.length,
    recall,
    mrr: meanStd(ok.map((o) => o.mrr)),
    ndcg: meanStd(ok.map((o) => o.ndcg)),
    latencyP50: percentile(ok.map((o) => o.retrievalLatencyMs), 50),
    latencyP95: percentile(ok.map((o) => o.retrievalLatencyMs), 95),
    rerankLatencyP50: rerankLatencies.length > 0 ? percentile(rerankLatencies, 50) : null,
    rerankFallbacks: ok.filter((o) => o.rerankFellBack === true).length,
    leakingObservations: ok.filter((o) => o.unauthorizedChunks > 0).length,
    unauthorizedChunksTotal: ok.reduce((a, o) => a + o.unauthorizedChunks, 0),
    crossTierLeakageRate: ok.length === 0 ? NaN : ok.filter((o) => o.unauthorizedChunks > 0).length / ok.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

const n3 = (v: number) => (Number.isNaN(v) ? "—" : v.toFixed(3));
const n1 = (v: number) => (Number.isNaN(v) ? "—" : v.toFixed(1));

/** "0.742 ± 0.000 †" — the dagger marks a deterministic arm. */
function pm(ms: MeanStd, deterministic: boolean): string {
  if (Number.isNaN(ms.mean)) return "—";
  const mark = deterministic && ms.std === 0 && ms.n > 1 ? " †" : "";
  return `${ms.mean.toFixed(3)} ± ${ms.std.toFixed(3)}${mark}`;
}

function isDeterministic(arm: ArmId): boolean {
  return arm !== "R4_hybrid_reranked";
}

function buildMarkdown(
  summaries: ArmSummary[],
  observations: Observation[],
  qrels: QrelsLoadResult,
  meta: { timestamp: string; repeats: number; scoredQueries: number; judgeUsed: boolean }
): string {
  const L: string[] = [];

  L.push("# ScholarAgent — Retrieval Benchmark");
  L.push("");
  L.push(`Generated ${meta.timestamp}`);
  L.push("");
  L.push("## Configuration");
  L.push("");
  L.push("| Setting | Value |");
  L.push("|---|---|");
  L.push(`| Queries scored | ${meta.scoredQueries} of ${GOLDEN_DATASET.length} |`);
  L.push(`| Repeats per query | ${meta.repeats} |`);
  L.push(`| Retrieval depth | top ${RETRIEVAL_LIMIT} |`);
  L.push(`| RRF k | ${RRF_K} |`);
  L.push(`| R4 stage-1 candidates | ${STAGE1_LIMIT} |`);
  L.push(`| R4 re-ranking judge | ${meta.judgeUsed ? `yes (LLM_PROVIDER=${process.env.LLM_PROVIDER ?? "unset"})` : "no — R4 fell back to R3 ordering"} |`);
  L.push(`| Judged candidates | ${qrels.judgedCandidates} of ${qrels.totalCandidates} |`);
  L.push("");

  L.push("## Experiment 1 — retrieval quality");
  L.push("");
  L.push("Mean ± population standard deviation across repeats.");
  L.push("");
  L.push("| Arm | Recall@3 | Recall@5 | Recall@10 | MRR | NDCG@5 |");
  L.push("|---|---|---|---|---|---|");
  for (const s of summaries) {
    const d = isDeterministic(s.arm);
    L.push(
      `| ${s.label} | ${pm(s.recall[3], d)} | ${pm(s.recall[5], d)} | ${pm(s.recall[10], d)} | ${pm(s.mrr, d)} | ${pm(s.ndcg, d)} |`
    );
  }
  L.push("");
  L.push("† Standard deviation is exactly 0 because the arm is deterministic SQL over a");
  L.push("fixed corpus — every repeat returns the same ranking. This is a statement about");
  L.push("determinism, not about reliability or confidence.");
  L.push("");

  L.push("## Latency");
  L.push("");
  L.push("Retrieval only. Query embedding is computed once per query and shared across");
  L.push("arms, so it is excluded here rather than charged to arms that need it. Percentiles");
  L.push("use the nearest-rank method with no interpolation, so each figure is an observed");
  L.push("measurement.");
  L.push("");
  L.push("| Arm | P50 (ms) | P95 (ms) | Re-rank P50 (ms) | Errors |");
  L.push("|---|---|---|---|---|");
  for (const s of summaries) {
    L.push(
      `| ${s.label} | ${n1(s.latencyP50)} | ${n1(s.latencyP95)} | ${s.rerankLatencyP50 === null ? "—" : n1(s.rerankLatencyP50)} | ${s.errors} |`
    );
  }
  L.push("");

  L.push("## Experiment 2 — cross-tier leakage");
  L.push("");
  L.push("Each query runs under its own permission tier. A leak is any returned chunk whose");
  L.push("classification is more privileged than the asking tier. No LLM is involved, so");
  L.push("this is a direct and deterministic test of whether a retrieval strategy can");
  L.push("bypass row-level security.");
  L.push("");
  L.push("| Arm | Leakage rate | Leaking observations | Unauthorised chunks |");
  L.push("|---|---|---|---|");
  for (const s of summaries) {
    const rate = Number.isNaN(s.crossTierLeakageRate) ? "—" : s.crossTierLeakageRate.toFixed(2);
    const flag = s.leakingObservations > 0 ? " **FAIL**" : "";
    L.push(
      `| ${s.label} | ${rate}${flag} | ${s.leakingObservations} / ${s.observations - s.errors} | ${s.unauthorizedChunksTotal} |`
    );
  }
  L.push("");
  const anyLeak = summaries.some((s) => s.leakingObservations > 0);
  if (anyLeak) {
    L.push("**A non-zero rate above is an RLS enforcement failure and a finding in its own**");
    L.push("**right.** Do not treat it as benchmark noise.");
  } else {
    L.push("All arms returned 0.00. Scope of that claim: it covers the *retrieval* stage");
    L.push("only, over the queries and corpus present at run time. It does not show the");
    L.push("model refuses to disclose material it was legitimately given, which is");
    L.push("generation-stage leakage and is measured separately with seeded canaries.");
  }
  L.push("");

  L.push("## Error analysis — five lowest-MRR queries");
  L.push("");
  const byQuery = new Map<string, number[]>();
  for (const o of observations) {
    if (o.error !== null || Number.isNaN(o.mrr)) continue;
    const arr = byQuery.get(o.queryId) ?? [];
    arr.push(o.mrr);
    byQuery.set(o.queryId, arr);
  }
  const ranked = [...byQuery.entries()]
    .map(([queryId, mrrs]) => ({ queryId, mrr: meanStd(mrrs).mean }))
    .sort((a, b) => a.mrr - b.mrr)
    .slice(0, 5);

  if (ranked.length === 0) {
    L.push("No scorable queries — see the annotation status above.");
  } else {
    for (const { queryId, mrr } of ranked) {
      const record = GOLDEN_DATASET.find((r) => r.id === queryId);
      const judged = qrels.judgements.get(queryId) ?? NO_JUDGEMENTS;
      const relevant = [...judged.entries()].filter(([, g]) => g > 0);
      L.push(`### ${queryId} — mean MRR ${n3(mrr)}`);
      L.push("");
      L.push(`- **Tier**: L${record?.userRole} (${PERMISSION_ROLE[record?.userRole ?? 3] ?? "?"})`);
      L.push(`- **Question**: ${record?.question ?? "(not found)"}`);
      L.push(`- **Judged relevant chunks**: ${relevant.length === 0 ? "none" : relevant.map(([id, g]) => `\`${id.slice(0, 8)}\`(g${g})`).join(", ")}`);
      for (const arm of ARM_IDS) {
        const o = observations.find((x) => x.queryId === queryId && x.arm === arm && x.error === null);
        const got = o?.retrievedIds.slice(0, 5).map((id) => {
          const g = judged.get(id);
          return `\`${id.slice(0, 8)}\`${g !== undefined && g > 0 ? `(g${g})` : ""}`;
        });
        L.push(`- **${arm} top 5**: ${got && got.length > 0 ? got.join(", ") : "nothing retrieved"}`);
      }
      L.push("");
    }
  }

  L.push("## Known limitations");
  L.push("");
  L.push("1. **Pool bias.** Judgements exist only for chunks some arm retrieved, so recall");
  L.push("   is measured over the judged set and is an upper bound on true recall. Arms are");
  L.push("   comparable because all are scored against the same pool.");
  L.push("2. **`ts_rank_cd` is not BM25.** PostgreSQL full-text search has no BM25; R1 uses");
  L.push("   coverage-density ranking. Do not describe it as BM25.");
  L.push("3. **No Hebrew stemming.** `websearch_to_tsquery('simple', …)` does not stem, and");
  L.push("   Hebrew attaches ו/ב/ל/ה/כ/מ/ש directly to words, so R1's recall is");
  L.push("   structurally capped. This is a property of the language and the available");
  L.push("   dictionaries, and is much of why fusion helps.");
  L.push("4. **R4 is not a cross-encoder.** No local cross-encoder is available, so an LLM");
  L.push("   scores candidates pointwise. It is subject to self-preference bias when the");
  L.push("   same model generates answers elsewhere in the system, and to position bias,");
  L.push("   which the per-repeat shuffle seed is there to expose.");
  L.push(`5. **Sample size.** ${meta.scoredQueries} scorable queries is small. Differences`);
  L.push("   between arms should be read with that in mind; this reports descriptive");
  L.push("   statistics and runs no significance test.");
  L.push("");

  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repeats = intFlag(argv, "--repeats", DEFAULT_REPEATS);
  const allowPartial = argv.includes("--allow-partial-qrels");

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Put it in .env.local.");
  }

  let qrels: QrelsLoadResult;
  try {
    qrels = await loadQrels(QRELS_PATH);
  } catch (err) {
    console.error(chalk.red("\n  Could not read relevance judgements."));
    console.error(`  Expected: ${QRELS_PATH}`);
    console.error(chalk.dim(`  ${err instanceof Error ? err.message : String(err)}`));
    console.error(chalk.bold("\n  Build the annotation pool first:  npm run qrels:pool\n"));
    process.exit(1);
  }

  const pending = [...qrels.unannotatedByQuery.values()].reduce((a, b) => a + b, 0);
  if (!annotationIsComplete(qrels) && !allowPartial) {
    console.error(chalk.red.bold("\n  Relevance judgements are incomplete."));
    console.error(`  ${qrels.judgedCandidates} judged, ${pending} still null.`);
    console.error(
      chalk.dim(
        "\n  An unjudged chunk is scored as irrelevant, which penalises arms unequally\n" +
          "  depending on which unjudged chunks each one favours — so partial annotation\n" +
          "  biases the comparison rather than merely adding noise.\n"
      )
    );
    console.error(chalk.bold("  Finish annotating, or pass --allow-partial-qrels to proceed anyway.\n"));
    process.exit(1);
  }

  const judgeUsed = (process.env.LLM_PROVIDER ?? "mock").toLowerCase() !== "mock";

  console.log(chalk.bold.green("\n  ScholarAgent — Retrieval Benchmark"));
  console.log(`  Arms     : ${ARM_IDS.length}   Repeats: ${repeats}   Depth: top ${RETRIEVAL_LIMIT}`);
  console.log(`  Scorable : ${qrels.queriesWithRelevant.size} of ${GOLDEN_DATASET.length} queries have a positive judgement`);
  if (qrels.queriesWithoutRelevant.size > 0) {
    console.log(
      chalk.yellow(
        `  Excluded : ${qrels.queriesWithoutRelevant.size} queries have no relevant chunk — their quality metrics are NaN, not 0`
      )
    );
  }
  if (!judgeUsed) {
    console.log(chalk.yellow("  R4       : no judge (LLM_PROVIDER is mock) — R4 will mirror R3"));
  }
  if (allowPartial && pending > 0) {
    console.log(chalk.red(`  WARNING  : running with ${pending} unjudged candidates — results are biased`));
  }
  console.log();

  // Embed every query once, shared by all arms and repeats.
  const embedded = new Map<string, EmbeddedQuery>();
  for (const record of GOLDEN_DATASET) {
    const e = await embedQueryOnce(record.question);
    if (e) embedded.set(record.id, e);
  }
  console.log(chalk.dim(`  Embedded ${embedded.size}/${GOLDEN_DATASET.length} queries\n`));

  const observations: Observation[] = [];

  for (const arm of ARM_IDS) {
    process.stdout.write(chalk.cyan(`  ${arm.padEnd(22)}`));
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const record of GOLDEN_DATASET) {
        const e = embedded.get(record.id);
        if (!e) continue;
        const judgements = qrels.judgements.get(record.id) ?? NO_JUDGEMENTS;
        observations.push(await observe(arm, record, e, repeat, judgements, judgeUsed));
      }
      process.stdout.write(chalk.gray("."));
    }
    const armObs = observations.filter((o) => o.arm === arm);
    const errs = armObs.filter((o) => o.error !== null).length;
    console.log(errs > 0 ? chalk.red(`  ${errs} errors`) : chalk.green("  ok"));
  }

  const summaries = ARM_IDS.map((arm) =>
    summarise(arm, observations.filter((o) => o.arm === arm))
  );

  const timestamp = new Date().toISOString();
  const fileStamp = timestamp.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

  const markdown = buildMarkdown(summaries, observations, qrels, {
    timestamp,
    repeats,
    scoredQueries: qrels.queriesWithRelevant.size,
    judgeUsed,
  });

  await mkdir(OUTPUT_DIR, { recursive: true });
  const jsonPath = path.join(OUTPUT_DIR, `benchmark_${fileStamp}.json`);
  const mdPath = path.join(OUTPUT_DIR, "benchmark_summary.md");

  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        timestamp,
        config: {
          repeats,
          retrievalLimit: RETRIEVAL_LIMIT,
          recallCutoffs: RECALL_CUTOFFS,
          ndcgCutoff: NDCG_CUTOFF,
          rrfK: RRF_K,
          stage1Limit: STAGE1_LIMIT,
          judgeUsed,
          llmProvider: process.env.LLM_PROVIDER ?? null,
          allowPartialQrels: allowPartial,
        },
        annotation: {
          totalCandidates: qrels.totalCandidates,
          judgedCandidates: qrels.judgedCandidates,
          pending,
          queriesWithRelevant: [...qrels.queriesWithRelevant],
          queriesWithoutRelevant: [...qrels.queriesWithoutRelevant],
        },
        summaries,
        observations,
      },
      null,
      2
    ),
    "utf-8"
  );
  await writeFile(mdPath, markdown, "utf-8");

  console.log(chalk.bold.green("\n  Benchmark complete."));
  console.log(`  JSON     → ${jsonPath}`);
  console.log(`  Markdown → ${mdPath}`);

  const leaking = summaries.filter((s) => s.leakingObservations > 0);
  if (leaking.length > 0) {
    console.log(
      chalk.red.bold(`\n  ✗ Cross-tier leakage detected in ${leaking.length} arm(s): ${leaking.map((s) => s.arm).join(", ")}`)
    );
    process.exitCode = 1;
  } else {
    console.log(chalk.green("\n  ✓ Cross-tier leakage 0.00 in every arm (retrieval stage).\n"));
  }
}

main().catch((err) => {
  console.error(chalk.red("\n  Benchmark failed:"), err);
  process.exit(1);
});
