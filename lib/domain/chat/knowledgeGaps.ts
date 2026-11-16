/**
 * Knowledge-gap detection — phase 1 of the knowledge flywheel.
 *
 * Records the questions the corpus could not answer, so the organisation can
 * see where its knowledge base is thin instead of only seeing a fluent reply.
 *
 * The system is currently built to hide exactly this. When retrieval returns
 * nothing, lib/domain/chat/rag.ts injects NO_AUTHORISED_CONTEXT, which tells the
 * model to fall back on general professional knowledge. The volunteer gets a
 * useful answer — which is right — and the organisation never learns it had no
 * material on the subject. That fallback stays; this module makes it leave a
 * trace.
 *
 * Phase 1 only writes. Nothing reads these rows yet and no user-visible
 * behaviour changes, so detection quality can be judged on real traffic before
 * a single expert is ever contacted.
 */

import { query } from "@/lib/core/db";
import { logError, logInfo } from "@/lib/core/logger";
import type { PermissionLevel } from "@/lib/security/auth";

import {
  CHIT_CHAT_INVARIANT_HE,
  INSUFFICIENT_CONTEXT_REPLY_HE,
  OUT_OF_DOMAIN_REPLY_HE,
} from "./rag";

/**
 * Which detector fired. Stored per row rather than collapsed to a boolean
 * because phase 1 exists to learn which signal is worth trusting.
 */
export type KnowledgeGapSignal = "model_declared_insufficient" | "empty_retrieval";

export interface GapDetectionInput {
  /** The final answer, after WhatsApp markdown formatting. */
  answer: string;
  /** Chunks the model actually saw, post-RLS. */
  retrievedChunks: readonly { similarity: number }[];
}

/** WhatsApp wraps RTL runs in bidi controls; they must not defeat a match. */
const BIDI_CONTROLS = /[‎‏‪-‮]/g;

/**
 * Collapses whitespace and strips bidi marks before comparison.
 *
 * The three replies are produced by a model told to emit them "EXACTLY", and
 * models comply approximately: a stray newline, a doubled space, or a directional
 * mark introduced by formatting are all routine. Matching the normalised form on
 * a substring basis absorbs that without needing the model to be perfect.
 */
function normalise(text: string): string {
  return text.replace(BIDI_CONTROLS, "").replace(/\s+/g, " ").trim();
}

function contains(haystack: string, needle: string): boolean {
  return normalise(haystack).includes(normalise(needle));
}

/**
 * Classifies one answered turn.
 *
 * Order matters and is the whole design. Chit-chat and out-of-domain are
 * checked FIRST and win outright, because both retrieve nothing: without that
 * precedence every "שלום" would be filed as a missing document and the gap
 * table would fill with greetings. A polluted gap table is worse than none,
 * because it costs expert attention to discover it is noise.
 *
 * `model_declared_insufficient` outranks `empty_retrieval` because it is a
 * judgement made after seeing the context rather than a proxy for one. The
 * model can read five retrieved chunks and still correctly conclude that none
 * of them answers the question; no retrieval-side signal can detect that.
 *
 * Returns null when the turn is not evidence of a gap.
 */
export function detectKnowledgeGap(input: GapDetectionInput): KnowledgeGapSignal | null {
  const { answer, retrievedChunks } = input;

  if (contains(answer, CHIT_CHAT_INVARIANT_HE)) return null;
  if (contains(answer, OUT_OF_DOMAIN_REPLY_HE)) return null;

  if (contains(answer, INSUFFICIENT_CONTEXT_REPLY_HE)) {
    return "model_declared_insufficient";
  }

  if (retrievedChunks.length === 0) return "empty_retrieval";

  return null;
}

/**
 * Best match among retrieved chunks, or null when nothing was retrieved.
 *
 * SCALE HAZARD: `similarity` is `1 - cosine` for the dense arm but `ts_rank_cd`
 * for the lexical arm, and RRF leaves whichever the source arm produced. This
 * value is therefore one of two incomparable scales, recorded for later analysis
 * and NOT usable as a confidence threshold until the retrieval arm is recorded
 * alongside it. See migrations/002_knowledge_gaps.sql.
 */
export function maxSimilarity(
  retrievedChunks: readonly { similarity: number }[]
): number | null {
  if (retrievedChunks.length === 0) return null;
  return retrievedChunks.reduce((best, c) => (c.similarity > best ? c.similarity : best), -Infinity);
}

export interface RecordKnowledgeGapInput {
  signal: KnowledgeGapSignal;
  /** PII-redacted question, as persisted to chat_history. Never commandText. */
  question: string;
  askerId: string;
  askerPermissionLevel: PermissionLevel;
  retrievedChunks: readonly { similarity: number }[];
  /** Meta message id; makes the write idempotent under BullMQ retries. */
  messageId?: string | null;
}

/**
 * Persists one detected gap. Best effort by construction.
 *
 * A gap row is observability, not the product. Losing one must never cost the
 * volunteer their answer, so every failure is logged and swallowed rather than
 * propagated into the retry machinery — the same policy chat_history writes
 * follow in lib/whatsapp/incomingMessageProcessor.ts.
 */
export async function recordKnowledgeGap(input: RecordKnowledgeGapInput): Promise<void> {
  try {
    await query(
      `INSERT INTO knowledge_gaps
         (question, asker_id, asker_permission_level, signal,
          max_similarity, retrieved_count, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      [
        input.question,
        input.askerId,
        input.askerPermissionLevel,
        input.signal,
        maxSimilarity(input.retrievedChunks),
        input.retrievedChunks.length,
        input.messageId ?? null,
      ]
    );

    logInfo("knowledge_gap_recorded", "Corpus could not answer this question.", {
      signal: input.signal,
      askerPermissionLevel: input.askerPermissionLevel,
      retrievedCount: input.retrievedChunks.length,
      messageId: input.messageId ?? null,
    });
  } catch (err) {
    logError("knowledge_gap_record_failed", err, {
      signal: input.signal,
      messageId: input.messageId ?? null,
    });
  }
}
