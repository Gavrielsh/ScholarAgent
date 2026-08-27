// Document ingestion pipeline: chunk -> describe -> extract -> ingest.
//
// Sections are in dependency order. chunker splits redacted text, chunkMetadata
// describes each chunk, uploader turns an uploaded file into a stored document,
// and documentIngestionProcessor drives the whole thing for a WhatsApp upload.
//
// Embedding lives in lib/domain/ingestion/embeddings.ts, not here. This file
// statically imports mammoth and pdf-parse, and the retrieval path needs
// embedText on every RAG query — merging the two would put both parsers in the
// chat agent's module graph.

import mammoth from "mammoth";
// pdf-parse v2 exports a class-based API with named exports (no default export).
// LoadParameters.data accepts Uint8Array | ArrayBuffer | Buffer.
// TextResult.text holds the concatenated text from all pages.
import { PDFParse } from "pdf-parse";
import { redactPii } from "@/lib/security/guardrails";
import {
  isElevatedRole,
  lookupUserByPhone,
  MANAGER_PERMISSION_LEVEL,
  type PermissionLevel,
  type UserContext,
} from "@/lib/security/auth";
import { randomUUID } from "node:crypto";
import {
  insertDocumentWithChunks,
  isUniqueViolation,
  type DocumentChunkRecord,
} from "@/lib/core/db";
import { parsePositiveInt } from "@/lib/core/env";
import { TerminalNotifyError } from "@/lib/core/queue";
import { abortableSleep, isAbortError, isHttpTimeoutError } from "@/lib/core/http/fetchWithTimeout";
import { embedTextBatch } from "@/lib/domain/ingestion/embeddings";
import { logError, logInfo, logWarn } from "@/lib/core/logger";
import {
  downloadWhatsAppMedia,
  isRetryableMediaError,
  sendWhatsAppTextMessage,
  UNAUTHORIZED_NUMBER_MESSAGE,
  WhatsAppMediaError,
} from "@/lib/domain/whatsapp/client";
import type { ParsedInboundDocumentEvent } from "@/lib/domain/whatsapp/types";

// -------------------------------------------------------------------------
// Chunking
// -------------------------------------------------------------------------

export interface Chunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  /** Target size in characters (semantic units are packed up to this budget). */
  chunkSize?: number;
  /** Overlap between consecutive chunks, in characters. */
  overlap?: number;
}

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_OVERLAP = 200;

// Hebrew end punctuation + Latin sentence ends.
const SENTENCE_SPLIT = /(?<=[.!?\u05C0\u05BE])\s+/u;

function mergeAbbreviationFragments(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const cur = p.trim();
    if (!cur) continue;
    const glued =
      out.length > 0 &&
      cur.length <= 4 &&
      /^[\u0590-\u05FFA-Za-z\u05F4\u05F3.+-]+$/.test(cur);
    if (glued) {
      out[out.length - 1] = `${out[out.length - 1]} ${cur}`.trim();
    } else {
      out.push(cur);
    }
  }
  return out;
}

function splitIntoSemanticUnits(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const units: string[] = [];
  for (const para of paragraphs) {
    const rawParts = para.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
    units.push(...mergeAbbreviationFragments(rawParts));
  }
  return units.length > 0 ? units : [text.trim()].filter(Boolean);
}

/**
 * Semantic-ish chunking: paragraph → sentence-like units (Hebrew + Latin aware),
 * then packs units into a character budget with overlap.
 */
export function chunkText(rawText: string, options: ChunkOptions = {}): Chunk[] {
  const text = redactPii(rawText).replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const chunkSize = Math.max(200, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULT_OVERLAP, chunkSize - 1));

  const units = splitIntoSemanticUnits(text);
  const effectiveUnits = units.length > 0 ? units : [text];

  const chunks: Chunk[] = [];
  let index = 0;
  let virtualCursor = 0;
  let current = "";

  const pushChunk = (body: string) => {
    const slice = body.trim();
    if (!slice) return;
    chunks.push({
      index,
      text: slice,
      charStart: virtualCursor,
      charEnd: virtualCursor + slice.length,
    });
    index += 1;
    virtualCursor += Math.max(1, slice.length - overlap);
  };

  for (const unit of effectiveUnits) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    if (current.trim()) {
      pushChunk(current);
      current = unit;
      continue;
    }

    // Single unit larger than budget — hard window with overlap on raw characters.
    for (let o = 0; o < unit.length; o += Math.max(1, chunkSize - overlap)) {
      const part = unit.slice(o, o + chunkSize);
      pushChunk(part);
    }
    current = "";
  }

  if (current.trim()) {
    pushChunk(current);
  }

  return chunks;
}

// -------------------------------------------------------------------------
// Chunk metadata
// -------------------------------------------------------------------------

/**
 * The metadata contract for a knowledge_base row.
 *
 * Every ingestion path (HTTP upload, WhatsApp document, reconciliation) builds
 * its chunk metadata here so the JSONB shape stays identical. Downstream code
 * depends on specific keys — `hardDeleteKnowledgeChunksByDocumentId` filters on
 * `document_id`, and the admin reports read `uploaded_by` — so a path that
 * spelled one of them differently would silently opt its own rows out of those
 * operations.
 *
 * This function is the only place those key names are written. The persistence
 * layer takes the finished payload and serialises it verbatim, so call this
 * rather than assembling the object at a call site.
 */
export interface ChunkMetadataInput {
  documentId: string;
  filename: string;
  mimeType: string;
  uploadedByUserId: string;
  classificationLevel: PermissionLevel;
  chunk: Pick<Chunk, "index" | "charStart" | "charEnd">;
  /** Channel-specific extras (media id, sender phone, original byte size…). */
  extra?: Record<string, unknown>;
}

export function buildChunkMetadata(input: ChunkMetadataInput): Record<string, unknown> {
  return {
    ...(input.extra ?? {}),
    document_id: input.documentId,
    filename: input.filename,
    mime_type: input.mimeType,
    uploaded_by: input.uploadedByUserId,
    // Mirrors classification_level so consumers can filter in SQL without joining.
    required_role: input.classificationLevel,
    chunk_index: input.chunk.index,
    char_start: input.chunk.charStart,
    char_end: input.chunk.charEnd,
  };
}

// -------------------------------------------------------------------------
// Upload extraction and ingestion
// -------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface UploadDocumentInput {
  filename: string;
  mimeType: string;
  /** Pre-extracted plain text (from extractTextFromUpload or callers that handle extraction themselves). */
  text: string;
  classificationLevel: PermissionLevel;
  uploadedByUserId: string;
  /** Must be L0 or L1 — used for write-path RLS. */
  uploadedByPermissionLevel: PermissionLevel;
  extraMetadata?: Record<string, unknown>;
  /** Override chunking parameters per document type (optional). */
  chunkOptions?: ChunkOptions;
  source?: string;
}

export interface UploadDocumentResult {
  documentId: string;
  chunkCount: number;
  insertedChunkIds: string[];
  failures: Array<{ index: number; error: string }>;
}

/**
 * Rejects a claimed MIME type that does not match the file's magic bytes.
 * Text types are not sniffed (UTF-8 has no reliable header).
 */
export function assertMimeMatchesContent(bytes: Uint8Array, mimeType: string): void {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "application/pdf") {
    const header = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
    if (header !== "%PDF") {
      throw new Error("סוג הקובץ המוצהר הוא PDF אך תוכן הקובץ אינו PDF.");
    }
    return;
  }
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error("סוג הקובץ המוצהר הוא DOCX אך תוכן הקובץ אינו ארכיון ZIP.");
    }
  }
}

// ---------------------------------------------------------------------------
// Core ingestion function
// ---------------------------------------------------------------------------

export async function ingestDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
  if (!input.text.trim()) {
    throw new Error("Cannot ingest a document with no extractable text.");
  }
  if (input.uploadedByPermissionLevel > MANAGER_PERMISSION_LEVEL) {
    throw new Error("Corpus writes require L0 or L1.");
  }

  const documentId = randomUUID();
  const sanitized = redactPii(input.text);
  const chunks = chunkText(sanitized, input.chunkOptions).filter((chunk) => chunk.text.trim());

  if (chunks.length === 0) {
    return { documentId, chunkCount: 0, insertedChunkIds: [], failures: [] };
  }

  const vectors = await embedTextBatch(chunks.map((c) => c.text));

  if (vectors.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch: got ${vectors.length}, expected ${chunks.length}.`
    );
  }

  const sizeBytes =
    typeof input.extraMetadata?.original_size_bytes === "number"
      ? input.extraMetadata.original_size_bytes
      : null;

  const result = await insertDocumentWithChunks({
    documentId,
    source: input.source ?? "upload_api",
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes,
    sha256: null,
    externalMediaId: null,
    externalMessageId: null,
    uploadedByUserId: input.uploadedByUserId,
    uploadedByPhone: null,
    classificationLevel: input.classificationLevel,
    writePermissionLevel: input.uploadedByPermissionLevel,
    documentMetadata: input.extraMetadata ?? {},
    chunks: chunks.map((chunk, i) => ({
      text: chunk.text,
      chunkIndex: chunk.index,
      metadata: buildChunkMetadata({
        documentId,
        filename: input.filename,
        mimeType: input.mimeType,
        uploadedByUserId: input.uploadedByUserId,
        classificationLevel: input.classificationLevel,
        chunk,
        extra: {
          source: input.source ?? "upload_api",
          ...(input.extraMetadata ?? {}),
        },
      }),
      embedding: vectors[i],
    })),
  });

  return {
    documentId: result.documentId,
    chunkCount: chunks.length,
    insertedChunkIds: result.insertedChunkIds,
    failures: [],
  };
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

type TextExtractor = (bytes: ArrayBuffer) => Promise<string>;

const EXTRACTORS: Record<string, TextExtractor> = {
  // Plain text formats — decoded directly as UTF-8; no additional libraries needed.
  "text/plain":    async (bytes) => new TextDecoder("utf-8").decode(bytes),
  "text/markdown": async (bytes) => new TextDecoder("utf-8").decode(bytes),
  "text/csv":      async (bytes) => new TextDecoder("utf-8").decode(bytes),

  // PDF — pdf-parse v2 class-based API.
  // PDFParse constructor accepts LoadParameters.data as Uint8Array | ArrayBuffer.
  // getText() returns a TextResult whose .text property holds the full document text.
  // destroy() releases the pdfjs DocumentLoadingTask and worker (prevents resource leaks
  // when many PDFs are processed in a batch ingestion loop).
  "application/pdf": async (bytes) => {
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const result = await parser.getText();
      return result.text.trim();
    } finally {
      await parser.destroy();
    }
  },

  // DOCX — mammoth (already in package.json as a dependency).
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    async (bytes) =>
      (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value ?? "",
};

/**
 * Extracts plain text from a raw file buffer based on its MIME type.
 * Throws for unsupported types rather than returning empty text silently.
 *
 * Supported MIME types:
 *   text/plain · text/markdown · text/csv
 *   application/pdf
 *   application/vnd.openxmlformats-officedocument.wordprocessingml.document
 */
export async function extractTextFromUpload(
  bytes: ArrayBuffer,
  mimeType: string
): Promise<string> {
  const extractor = EXTRACTORS[mimeType];
  if (!extractor) {
    const supported = Object.keys(EXTRACTORS).join(", ");
    throw new Error(
      `Unsupported MIME type for text extraction: "${mimeType}". Supported: ${supported}`
    );
  }
  return extractor(bytes);
}

// -------------------------------------------------------------------------
// WhatsApp document ingestion processor
// -------------------------------------------------------------------------

// ── Replies ────────────────────────────────────────────────────────────────
const SUCCESS_MESSAGE = "המסמך עובד בהצלחה וזמין במערכת.";
const FAILURE_MESSAGE = "עיבוד המסמך נכשל. אפשר לנסות לשלוח אותו שוב בעוד מספר דקות.";
// Identical wording to lib/domain/whatsapp/webhook.ts: an unregistered
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
