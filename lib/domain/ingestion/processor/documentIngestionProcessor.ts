import { randomUUID } from "node:crypto";

import { isElevatedRole } from "@/lib/security/auth/roles";
import { MANAGER_PERMISSION_LEVEL } from "@/lib/security/auth/rls";
import type { PermissionLevel, UserContext } from "@/lib/security/auth/types";
import {
  insertDocumentWithChunks,
  isUniqueViolation,
  type DocumentChunkRecord,
} from "@/lib/core/db";
import { lookupUserByPhone } from "@/lib/security/auth/userRegistry";
import { parsePositiveInt } from "@/lib/core/env";
import { TerminalNotifyError } from "@/lib/core/queue/jobRuntime";
import { abortableSleep, isAbortError, isHttpTimeoutError } from "@/lib/core/http/fetchWithTimeout";
import { chunkText, type Chunk } from "@/lib/domain/ingestion/processor/chunker";
import { buildChunkMetadata } from "@/lib/domain/ingestion/processor/chunkMetadata";
import { embedTextBatch } from "@/lib/domain/ingestion/processor/embeddings";
import { redactPii } from "@/lib/security/privacy/piiRedact";
import { extractTextFromUpload } from "@/lib/domain/ingestion/processor/uploader";
import { logError, logInfo, logWarn } from "@/lib/core/logger";
import {
  downloadWhatsAppMedia,
  isRetryableMediaError,
  WhatsAppMediaError,
} from "@/lib/domain/whatsapp/core/mediaDownload";
import { sendWhatsAppTextMessage } from "@/lib/domain/whatsapp/core/sendMessage";
import type { ParsedInboundDocumentEvent } from "@/lib/domain/whatsapp/core/types";
import { UNAUTHORIZED_NUMBER_MESSAGE } from "@/lib/domain/whatsapp/core/userMessages";

// ── Replies ────────────────────────────────────────────────────────────────
const SUCCESS_MESSAGE = "המסמך עובד בהצלחה וזמין במערכת.";
const FAILURE_MESSAGE = "עיבוד המסמך נכשל. אפשר לנסות לשלוח אותו שוב בעוד מספר דקות.";
// Identical wording to lib/domain/whatsapp/core/incomingMessageProcessor.ts: an unregistered
// number must not be able to tell the two paths apart.
const PERMISSION_DENIED_MESSAGE =
  "אין לך הרשאה להוסיף מסמכים למאגר הידע. הפעולה שמורה לצוות מטה (L0) ולמנהלות הכשרה (L1).";
const UNSUPPORTED_TYPE_MESSAGE =
  "סוג הקובץ אינו נתמך. אפשר לשלוח קבצים מסוג PDF, DOCX, TXT, MD או CSV.";
const NO_TEXT_MESSAGE =
  "לא נמצא במסמך טקסט שניתן לחלץ. ייתכן שמדובר בסריקה או בתמונה ללא שכבת טקסט.";
const TOO_LARGE_MESSAGE = "המסמך גדול מכדי להיקלט בבת אחת. כדאי לפצל אותו ולשלוח שוב.";

// ── Tuning ─────────────────────────────────────────────────────────────────
/**
 * Chunks are embedded in slices rather than in one call.
 *
 * `embedTextBatch` already retries a 429 with exponential backoff, but a single
 * request carrying 300 chunks is *itself* what trips the free-tier quota, and
 * every retry of it re-sends all 300. Small slices keep each request under the
 * limit so throttling stays rare and cheap when it does happen.
 */
const EMBED_BATCH_SIZE = parsePositiveInt(process.env.DOCUMENT_EMBED_BATCH_SIZE, 16);
/** Paced gap between slices; the free Gemini tier is requests-per-minute limited. */
const EMBED_BATCH_PAUSE_MS = Number(process.env.DOCUMENT_EMBED_BATCH_PAUSE_MS ?? 250);
/** Backstop against a 900-page PDF consuming an entire quota window. */
const MAX_CHUNKS_PER_DOCUMENT = parsePositiveInt(process.env.DOCUMENT_MAX_CHUNKS, 400);

/**
 * Default corpus tier for a document that arrives without a level directive.
 *
 * L1 means "visible to L0 and L1 only" under the RLS rule in lib/security/auth/rls.ts
 * (`classification_level >= user permission level`). Defaulting to the most
 * restrictive useful tier is the safe direction to be wrong in: widening a
 * document later is an UPDATE, whereas un-leaking one is not possible.
 */
const DEFAULT_CLASSIFICATION_LEVEL: PermissionLevel = MANAGER_PERMISSION_LEVEL;

/** `#L3`, `level: 2`, `רמה 0` — all forms an admin might reasonably type. */
const CLASSIFICATION_DIRECTIVE = /(?:#\s*l|level|רמה)\s*[:=]?\s*([0-3])\b/i;

export interface DocumentIngestionContext {
  /** 1-based index of the attempt currently executing. */
  attempt: number;
  /** Total attempts configured on the job (`job.opts.attempts`). */
  maxAttempts: number;
  /** Fires on job deadline or worker shutdown; forwarded to every network call. */
  signal: AbortSignal;
}

/**
 * A failure the sender caused and can fix (wrong file type, scanned PDF, file
 * too big). Answered immediately with a specific message and never retried —
 * three attempts at parsing the same image-only PDF produce the same result
 * three times and delay the explanation the admin needs.
 */
class DocumentIngestionUserError extends Error {
  readonly reply: string;

  constructor(reply: string, detail: string) {
    super(detail);
    this.name = "DocumentIngestionUserError";
    this.reply = reply;
  }
}

async function reply(to: string, body: string, signal: AbortSignal | null): Promise<void> {
  await sendWhatsAppTextMessage({ to, body, signal });
}

/**
 * Resolves the corpus tier for this document.
 *
 * The clamp is the security-relevant half: `Math.max` against the sender's own
 * level means an L1 Manager cannot publish at L0, which would create content
 * they are themselves able to write but not retrieve, and would let a Manager
 * seed the admin-only tier. It mirrors the same rule enforced by the HTTP
 * upload route in app/api/upload/route.ts.
 */
export function resolveClassificationLevel(
  caption: string | null,
  senderLevel: PermissionLevel
): PermissionLevel {
  const match = caption?.match(CLASSIFICATION_DIRECTIVE);
  const requested = match ? (Number.parseInt(match[1], 10) as PermissionLevel) : DEFAULT_CLASSIFICATION_LEVEL;
  return Math.max(requested, senderLevel) as PermissionLevel;
}

/**
 * Embeds every chunk, in slices, preserving index alignment with `chunks`.
 *
 * `embedTextBatch` guarantees alignment within a slice; concatenating slices in
 * order preserves it across them. That alignment is load-bearing — a shifted
 * vector attaches the wrong embedding to the wrong text and silently poisons
 * retrieval for the life of the row.
 */
async function embedChunksInBatches(chunks: Chunk[], signal: AbortSignal): Promise<number[][]> {
  const vectors: number[][] = [];

  for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
    if (signal.aborted) {
      throw new Error("Document ingestion cancelled before embedding finished.");
    }

    const slice = chunks.slice(start, start + EMBED_BATCH_SIZE);
    const batch = await embedTextBatch(
      slice.map((c) => c.text),
      signal
    );

    if (batch.length !== slice.length) {
      throw new Error(
        `Embedding count mismatch: got ${batch.length}, expected ${slice.length}.`
      );
    }

    vectors.push(...batch);

    const hasMore = start + EMBED_BATCH_SIZE < chunks.length;
    if (hasMore && EMBED_BATCH_PAUSE_MS > 0) {
      await abortableSleep(EMBED_BATCH_PAUSE_MS, signal);
    }
  }

  return vectors;
}

/**
 * Authorisation gate.
 *
 * Runs here rather than in the webhook route on purpose: the route must ACK
 * within a couple of seconds or Meta redelivers, and a `users` lookup is a
 * Postgres round trip. The route ACKs 200 unconditionally; the decision to
 * accept or refuse the document is made on this side of the queue.
 *
 * Returns null when the sender was already answered and processing must stop.
 */
async function authorizeSender(
  event: ParsedInboundDocumentEvent,
  ctx: DocumentIngestionContext
): Promise<UserContext | null> {
  // A UserRegistryDbError propagates on purpose: Postgres being unreachable is
  // transient, so BullMQ should retry silently rather than tell an admin they
  // lack permission they actually have.
  const user = await lookupUserByPhone(event.senderId);

  if (!user) {
    await reply(event.senderId, UNAUTHORIZED_NUMBER_MESSAGE, ctx.signal);
    return null;
  }

  if (!isElevatedRole(user.permissionLevel)) {
    logWarn(
      "document_ingestion_permission_denied",
      "Non-admin attempted to upload a document via WhatsApp.",
      {
        senderId: event.senderId,
        messageId: event.messageId,
        permissionLevel: user.permissionLevel,
        filename: event.filename,
      }
    );
    await reply(event.senderId, PERMISSION_DENIED_MESSAGE, ctx.signal);
    return null;
  }

  return user;
}

/** Download → parse → redact → chunk. Throws `DocumentIngestionUserError` on bad input. */
async function extractChunks(
  event: ParsedInboundDocumentEvent,
  ctx: DocumentIngestionContext
): Promise<{ chunks: Chunk[]; sizeBytes: number; sha256: string | null }> {
  let media;
  try {
    media = await downloadWhatsAppMedia(event.mediaId, { signal: ctx.signal });
  } catch (err) {
    // Meta rejecting the media id (expired handle, 4xx) will not change on a
    // retry, so it is turned into a terminal answer instead of burning attempts.
    if (err instanceof WhatsAppMediaError && !isRetryableMediaError(err)) {
      throw new DocumentIngestionUserError(TOO_LARGE_MESSAGE, err.message);
    }
    throw err;
  }

  // REUSE: the same extractor table the HTTP upload route uses, so PDF/DOCX/
  // text handling cannot diverge between the two ingestion channels.
  let rawText: string;
  try {
    rawText = await extractTextFromUpload(media.bytes, event.mimeType);
  } catch (err) {
    throw new DocumentIngestionUserError(
      UNSUPPORTED_TYPE_MESSAGE,
      err instanceof Error ? err.message : String(err)
    );
  }

  if (!rawText.trim()) {
    throw new DocumentIngestionUserError(
      NO_TEXT_MESSAGE,
      `No extractable text in ${event.filename} (${event.mimeType}).`
    );
  }

  // REUSE: redactPii before anything is embedded, logged, or persisted.
  // chunkText redacts again internally; that is idempotent, and doing it here
  // means the length/emptiness checks below run on already-masked text.
  const redacted = redactPii(rawText);

  // REUSE: the Hebrew/Latin-aware semantic chunker.
  const chunks = chunkText(redacted).filter((chunk) => chunk.text.trim().length > 0);

  if (chunks.length === 0) {
    throw new DocumentIngestionUserError(
      NO_TEXT_MESSAGE,
      `Chunking produced nothing usable for ${event.filename}.`
    );
  }

  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
    throw new DocumentIngestionUserError(
      TOO_LARGE_MESSAGE,
      `${chunks.length} chunks exceeds the ${MAX_CHUNKS_PER_DOCUMENT}-chunk ceiling.`
    );
  }

  return { chunks, sizeBytes: media.sizeBytes, sha256: media.sha256 ?? event.sha256 };
}

/** Happy path. Throws on any failure; `processDocumentIngestion` owns the policy. */
async function handleDocumentIngestion(
  event: ParsedInboundDocumentEvent,
  ctx: DocumentIngestionContext
): Promise<void> {
  // ── STEP 1: identity + RBAC ───────────────────────────────────────────────
  const user = await authorizeSender(event, ctx);
  if (!user) return;

  const classificationLevel = resolveClassificationLevel(event.caption, user.permissionLevel);

  // ── STEP 2: download, parse, redact, chunk ────────────────────────────────
  const { chunks, sizeBytes, sha256 } = await extractChunks(event, ctx);

  // ── STEP 3: embed in rate-limit-friendly batches ──────────────────────────
  const vectors = await embedChunksInBatches(chunks, ctx.signal);

  // Generated up front: every chunk's metadata embeds it, and the document row
  // and its chunks must agree on the same id.
  const documentId = randomUUID();

  const chunkMetadata = {
    source: "whatsapp",
    organization_id: user.organizationId ?? null,
    wa_media_id: event.mediaId,
    wa_message_id: event.messageId,
    original_size_bytes: sizeBytes,
  };

  const records: DocumentChunkRecord[] = chunks.map((chunk, i) => ({
    text: chunk.text,
    chunkIndex: chunk.index,
    metadata: buildChunkMetadata({
      documentId,
      filename: event.filename,
      mimeType: event.mimeType,
      uploadedByUserId: user.userId,
      classificationLevel,
      chunk,
      extra: chunkMetadata,
    }),
    embedding: vectors[i],
  }));

  // ── STEP 4: single transaction — document row + every chunk ───────────────
  const result = await insertDocumentWithChunks({
    documentId,
    source: "whatsapp",
    filename: event.filename,
    mimeType: event.mimeType,
    sizeBytes,
    sha256,
    externalMediaId: event.mediaId,
    externalMessageId: event.messageId,
    uploadedByUserId: user.userId,
    uploadedByPhone: event.senderId,
    classificationLevel,
    writePermissionLevel: user.permissionLevel,
    documentMetadata: {
      organization_id: user.organizationId ?? null,
      uploaded_via: "whatsapp",
      caption: event.caption,
    },
    chunks: records,
  });

  logInfo("document_ingestion_completed", "Document stored in the knowledge base.", {
    senderId: event.senderId,
    messageId: event.messageId,
    documentId: result.documentId,
    filename: event.filename,
    mimeType: event.mimeType,
    classificationLevel,
    chunkCount: chunks.length,
    insertedChunks: result.insertedChunkIds.length,
    alreadyIngested: result.alreadyIngested,
  });

  // ── STEP 5: close the loop ────────────────────────────────────────────────
  await reply(event.senderId, SUCCESS_MESSAGE, ctx.signal);
}

/**
 * Failure policy, deliberately identical in shape to the chat pipeline's
 * (see `handleProcessingFailure` in incomingMessageProcessor.ts):
 *
 *   - user error       → one specific explanation, then resolve. No retry.
 *   - unique violation → an earlier attempt already committed; confirm success.
 *   - not the last try → stay silent and rethrow so BullMQ retries.
 *   - the last try     → notify once, then RESOLVE so the retry loop terminates.
 */
async function handleIngestionFailure(
  err: unknown,
  event: ParsedInboundDocumentEvent,
  ctx: DocumentIngestionContext
): Promise<void> {
  if (err instanceof TerminalNotifyError) {
    throw err;
  }

  const { senderId, messageId } = event;

  if (err instanceof DocumentIngestionUserError) {
    logWarn("document_ingestion_rejected", err.message, {
      senderId,
      messageId,
      filename: event.filename,
      mimeType: event.mimeType,
    });
    await notify(event, err.reply, ctx);
    return;
  }

  // The document row is keyed on the Meta message id (migration 007), so a
  // duplicate means the work is already in the corpus. Confirming is correct;
  // retrying could only produce the same violation again.
  if (isUniqueViolation(err)) {
    logInfo("document_ingestion_duplicate_ignored", "Unique violation treated as success.", {
      senderId,
      messageId,
      attempt: ctx.attempt,
    });
    await notify(event, SUCCESS_MESSAGE, ctx);
    return;
  }

  const isFinalAttempt = ctx.attempt >= ctx.maxAttempts;
  const aborted = isAbortError(err);
  const timedOut = isHttpTimeoutError(err);

  logError("document_ingestion_failed", err, {
    senderId,
    messageId,
    filename: event.filename,
    mimeType: event.mimeType,
    attempt: ctx.attempt,
    maxAttempts: ctx.maxAttempts,
    isFinalAttempt,
    timedOut,
    aborted: aborted && !timedOut,
  });

  if (!isFinalAttempt) {
    throw err;
  }

  await notify(event, FAILURE_MESSAGE, ctx);
}

/**
 * Best-effort terminal notification.
 *
 * `signal: null` is deliberate — if the job deadline is what failed, ctx.signal
 * is already aborted and passing it would suppress the one message the admin
 * actually needs. A send failure here is swallowed: rethrowing would restart
 * the retry loop this branch exists to end.
 */
async function notify(
  event: ParsedInboundDocumentEvent,
  body: string,
  ctx: DocumentIngestionContext
): Promise<void> {
  try {
    await sendWhatsAppTextMessage({ to: event.senderId, body, signal: null });
  } catch (sendErr) {
    logError("document_ingestion_notice_failed", sendErr, {
      senderId: event.senderId,
      messageId: event.messageId,
      attempt: ctx.attempt,
    });
    throw new TerminalNotifyError(sendErr);
  }
}

/**
 * Business logic for one inbound document. Runs inside the BullMQ worker, which
 * owns the read receipt and the job deadline around this call.
 *
 * Resolves on terminal failure by design — see `handleIngestionFailure`.
 */
export async function processDocumentIngestion(
  event: ParsedInboundDocumentEvent,
  ctx: DocumentIngestionContext
): Promise<void> {
  try {
    await handleDocumentIngestion(event, ctx);
  } catch (err) {
    await handleIngestionFailure(err, event, ctx);
  }
}
