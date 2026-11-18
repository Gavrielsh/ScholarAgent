/**
 * qrels.ts — relevance judgements for the retrieval benchmark.
 *
 * ## Why this file exists
 *
 * Recall@k, MRR and NDCG@k are defined against a set of *known relevant
 * documents* per query. The golden dataset does not contain one: it has
 * `expectedContextHints` (keywords) and `expectedContextSegments` (topic
 * labels), neither of which identifies a chunk. Computing IR metrics from
 * keyword overlap would measure keyword overlap, not retrieval quality.
 *
 * So judgements are annotated by hand against the real corpus:
 *
 *   1. `npm run qrels:pool` runs all four arms with RLS bypassed and writes the
 *      union of their results to scripts/data/qrels.jsonl, one candidate per
 *      line with `grade: null`.
 *   2. A human sets each `grade` to 0, 1 or 2.
 *   3. This loader reads the annotated file.
 *
 * ## Pool bias — state this alongside every recall number
 *
 * Judgements exist only for chunks some arm retrieved. A relevant chunk that no
 * arm ever surfaced was never annotated, so it cannot be counted as missed.
 * Recall is therefore recall over the *judged* set and is an upper bound on true
 * recall. This is the standard limitation of TREC-style pooling and does not
 * invalidate comparisons between arms — every arm is scored against the same
 * pool — but it does mean the absolute numbers are optimistic.
 */

import { readFile } from "node:fs/promises";
import type { RelevanceGrade } from "@/lib/core/irMetrics";
import type { ArmId } from "@/lib/domain/ingestion/retrievalArms";

/** One line of qrels.jsonl. */
export interface QrelCandidate {
  queryId: string;
  chunkId: string;
  /** null until a human has judged it. */
  grade: RelevanceGrade | null;
  classificationLevel: number;
  /** Rank this chunk reached in each arm, for pool provenance. */
  arms: Partial<Record<ArmId, number>>;
  /** Leading text, so the annotator can judge without a DB query. */
  excerpt: string;
  /** Corpus-relative path of the source document, when it came from the corpus. */
  source_path?: string | null;
  /** Clearance the query was asked under, for reading the row in context. */
  query_tier?: string;
  /**
   * Whether the chunk's document is one the golden dataset expects for this
   * query. A hint only: the dataset's expectations are document-level, and a
   * chunk from an expected document can still be the wrong section of it. The
   * annotator decides; `grade` stays null until they do.
   */
  in_expected_doc?: boolean;
}

export interface QrelsLoadResult {
  /** queryId → (chunkId → grade), judged entries only. */
  judgements: Map<string, Map<string, RelevanceGrade>>;
  totalCandidates: number;
  judgedCandidates: number;
  /** Queries with at least one grade > 0. Only these can be scored. */
  queriesWithRelevant: Set<string>;
  /** Queries present in the pool but with no positive judgement. */
  queriesWithoutRelevant: Set<string>;
  unannotatedByQuery: Map<string, number>;
}

function isGrade(value: unknown): value is RelevanceGrade {
  return value === 0 || value === 1 || value === 2;
}

/**
 * Reads and validates qrels.jsonl.
 *
 * A malformed line is a hard error rather than a skip: silently dropping a line
 * would quietly shrink the relevant set and inflate precision-like metrics.
 */
export async function loadQrels(filePath: string): Promise<QrelsLoadResult> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const judgements = new Map<string, Map<string, RelevanceGrade>>();
  const unannotatedByQuery = new Map<string, number>();
  const allQueryIds = new Set<string>();
  let judgedCandidates = 0;

  lines.forEach((line, i) => {
    let parsed: QrelCandidate;
    try {
      parsed = JSON.parse(line) as QrelCandidate;
    } catch {
      throw new Error(`qrels line ${i + 1} is not valid JSON`);
    }

    if (typeof parsed.queryId !== "string" || typeof parsed.chunkId !== "string") {
      throw new Error(`qrels line ${i + 1} is missing queryId or chunkId`);
    }
    allQueryIds.add(parsed.queryId);

    if (parsed.grade === null || parsed.grade === undefined) {
      unannotatedByQuery.set(parsed.queryId, (unannotatedByQuery.get(parsed.queryId) ?? 0) + 1);
      return;
    }
    if (!isGrade(parsed.grade)) {
      throw new Error(
        `qrels line ${i + 1} has grade ${JSON.stringify(parsed.grade)}; expected 0, 1, 2 or null`
      );
    }

    let perQuery = judgements.get(parsed.queryId);
    if (!perQuery) {
      perQuery = new Map<string, RelevanceGrade>();
      judgements.set(parsed.queryId, perQuery);
    }
    perQuery.set(parsed.chunkId, parsed.grade);
    judgedCandidates++;
  });

  const queriesWithRelevant = new Set<string>();
  for (const [queryId, perQuery] of judgements) {
    for (const grade of perQuery.values()) {
      if (grade > 0) {
        queriesWithRelevant.add(queryId);
        break;
      }
    }
  }

  const queriesWithoutRelevant = new Set(
    [...allQueryIds].filter((id) => !queriesWithRelevant.has(id))
  );

  return {
    judgements,
    totalCandidates: lines.length,
    judgedCandidates,
    queriesWithRelevant,
    queriesWithoutRelevant,
    unannotatedByQuery,
  };
}

/** Empty judgements for a query absent from the pool. */
export const NO_JUDGEMENTS: ReadonlyMap<string, RelevanceGrade> = new Map();

/**
 * Whether the annotation is complete enough to report metrics.
 *
 * Partial annotation does not just add noise, it biases: an unjudged chunk is
 * treated as irrelevant, so every arm that retrieved it is penalised, and arms
 * are penalised unequally depending on which unjudged chunks they favour.
 */
export function annotationIsComplete(result: QrelsLoadResult): boolean {
  return result.unannotatedByQuery.size === 0 && result.judgedCandidates > 0;
}
