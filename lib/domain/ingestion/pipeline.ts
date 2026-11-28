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
  redactPhone,
  type PermissionLevel,
  type UserContext,
} from "@/lib/security/auth";
import { randomUUID } from "node:crypto";
import {
  insertDocumentWithChunks,
  isUniqueViolation,
  type DocumentChunkRecord,
} from "@/lib/core/db";
import { parseNonNegativeInt, parsePositiveInt } from "@/lib/core/env";
import { TerminalNotifyError, UserNotifiedFailureError } from "@/lib/core/queue";
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
  /**
   * Nearest section heading at or above this chunk, when the document has
   * detectable structure. Feeds the contextual header — see
   * `buildContextualHeader`.
   */
  section?: string | null;
}

export interface ChunkOptions {
  /** Target size in characters (semantic units are packed up to this budget). */
  chunkSize?: number;
  /** Overlap between consecutive chunks, in characters. */
  overlap?: number;
}

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_OVERLAP = 200;

/**
 * Parent/child ("small-to-big") chunk budgets.
 *
 * Children are embedded and searched: small enough that one embedding describes
 * one idea, which is what makes the dense leg precise. Parents are what the LLM
 * actually reads, so they carry enough surrounding text to be coherent. See
 * migrations/004_parent_child_chunks.sql.
 */
const PARENT_CHUNK_SIZE = 1400;
const PARENT_OVERLAP = 0;
const CHILD_CHUNK_SIZE = 400;
const CHILD_OVERLAP = 60;

// -------------------------------------------------------------------------
// Section headings and the contextual header
// -------------------------------------------------------------------------

/** Hebrew structural words that introduce a numbered division. */
const HE_SECTION_WORDS = "סעיף|פרק|נספח|תת-סעיף|חלק|פרק משנה";

const MARKDOWN_HEADING = /^#{1,6}\s+(.+?)\s*#*$/u;
const BOLD_ONLY_HEADING = /^(?:\*\*|__)(.+?)(?:\*\*|__)$/u;
const NUMBERED_HEADING = /^\d+(?:\.\d+)*[.)]?\s+\S/u;
const HE_WORD_HEADING = new RegExp(`^(?:${HE_SECTION_WORDS})\\s`, "u");
const ENDS_SENTENCE = /[.!?:;,׀־]$/u;

const MAX_HEADING_LENGTH = 120;

/**
 * Best-effort section-heading detector for a single line.
 *
 * Deliberately conservative: a false positive mislabels a chunk's section in
 * the contextual header, which is noise in the embedding, so a line has to look
 * structural rather than merely short. Returns the heading text, or null.
 *
 * Exported for the test that pins which shapes count.
 */
export function detectSectionHeading(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) return null;

  const md = trimmed.match(MARKDOWN_HEADING);
  if (md?.[1]) return md[1].trim();

  const bold = trimmed.match(BOLD_ONLY_HEADING);
  if (bold?.[1] && !ENDS_SENTENCE.test(bold[1].trim())) return bold[1].trim();

  // "3.2 תקרת החזר" / "4) Travel budget" — a numbered division label.
  if (NUMBERED_HEADING.test(trimmed) && !ENDS_SENTENCE.test(trimmed)) return trimmed;

  // "סעיף 5 — נהלי דיווח"
  if (HE_WORD_HEADING.test(trimmed) && !ENDS_SENTENCE.test(trimmed)) return trimmed;

  return null;
}

/**
 * The contextual header prepended to every stored chunk body.
 *
 * It is part of `content`, not just of the embedding input, for two reasons:
 * `content_tsv` is a GENERATED column over `content` (migration 001), so the
 * lexical leg only sees the header if it is stored; and a retrieved chunk then
 * carries its own provenance into the LLM context instead of arriving as an
 * anonymous fragment.
 *
 * Hebrew is the user-facing language, so the header is Hebrew (see CLAUDE.md).
 */
export function buildContextualHeader(input: {
  filename: string;
  classificationLevel: PermissionLevel;
  section?: string | null;
}): string {
  const section = input.section?.trim();
  return (
    `[מסמך: ${input.filename} | רמת סיווג: L${input.classificationLevel}` +
    `${section ? ` | סעיף: ${section}` : ""}]\n`
  );
}

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

/** A sentence-like unit tagged with the section heading in force above it. */
interface SemanticUnit {
  text: string;
  section: string | null;
}

function splitIntoSemanticUnits(text: string): SemanticUnit[] {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const units: SemanticUnit[] = [];
  let currentSection: string | null = null;

  // Body lines are rejoined with "\n" exactly as they arrived, so a document
  // with no detectable headings splits identically to before this change.
  const flushBody = (lines: string[]) => {
    const body = lines.join("\n").trim();
    if (!body) return;
    const rawParts = body.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
    for (const part of mergeAbbreviationFragments(rawParts)) {
      units.push({ text: part, section: currentSection });
    }
  };

  for (const para of paragraphs) {
    let buffer: string[] = [];
    for (const line of para.split("\n")) {
      const heading = detectSectionHeading(line);
      if (heading === null) {
        buffer.push(line);
        continue;
      }
      // Everything buffered belongs to the PREVIOUS section, so flush before
      // the heading takes effect.
      flushBody(buffer);
      buffer = [];
      currentSection = heading;
      // The heading line stays in the corpus as content — dropping it would
      // lose text that is often the most searchable part of the document.
      units.push({ text: line.trim(), section: currentSection });
    }
    flushBody(buffer);
  }

  if (units.length > 0) return units;
  const whole = text.trim();
  return whole ? [{ text: whole, section: null }] : [];
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

  // Non-empty by construction: `text` is trimmed and non-empty above, and
  // splitIntoSemanticUnits falls back to the whole text when it finds no units.
  const units = splitIntoSemanticUnits(text);

  const chunks: Chunk[] = [];
  let index = 0;
  let virtualCursor = 0;
  let current = "";
  // The section of the first unit packed into `current` — a chunk is labelled
  // by where it starts, not by a heading it happens to run into.
  let currentSection: string | null = null;

  const pushChunk = (body: string, section: string | null) => {
    const slice = body.trim();
    if (!slice) return;
    chunks.push({
      index,
      text: slice,
      charStart: virtualCursor,
      charEnd: virtualCursor + slice.length,
      section,
    });
    index += 1;
    virtualCursor += Math.max(1, slice.length - overlap);
  };

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit.text}` : unit.text;
    if (candidate.length <= chunkSize) {
      if (!current) currentSection = unit.section;
      current = candidate;
      continue;
    }

    if (current.trim()) {
      pushChunk(current, currentSection);
      current = unit.text;
      currentSection = unit.section;
      continue;
    }

    // Single unit larger than budget — hard window with overlap on raw characters.
    for (let o = 0; o < unit.text.length; o += Math.max(1, chunkSize - overlap)) {
      const part = unit.text.slice(o, o + chunkSize);
      pushChunk(part, unit.section);
    }
    current = "";
    currentSection = null;
  }

  if (current.trim()) {
    pushChunk(current, currentSection);
  }

  return chunks;
}

// -------------------------------------------------------------------------
// Parent / child chunking
// -------------------------------------------------------------------------

/** A child chunk plus the index of the parent whose text contains it. */
export interface ChildChunk extends Chunk {
  parentIndex: number;
}

export interface ParentChildChunks {
  /** ~1,400 chars. Stored with is_parent = true and embedding = NULL. */
  parents: Chunk[];
  /** ~400 chars. Embedded and searched; each links to parents[parentIndex]. */
  children: ChildChunk[];
}

/**
 * Splits text into large parent chunks and the small child chunks that index
 * them ("small-to-big" retrieval).
 *
 * Both levels come from the same `chunkText` so the Hebrew/Latin sentence logic
 * and the heading detection are not duplicated, and a child inherits its
 * parent's section when its own slice contains no heading.
 *
 * A parent with exactly one child is normal for short documents; the retrieval
 * path handles it without a special case.
 */
export function chunkTextParentChild(
  rawText: string,
  options: ChunkOptions = {}
): ParentChildChunks {
  const parents = chunkText(rawText, {
    chunkSize: options.chunkSize ?? PARENT_CHUNK_SIZE,
    overlap: options.overlap ?? PARENT_OVERLAP,
  });

  const children: ChildChunk[] = [];
  let childIndex = 0;

  parents.forEach((parent, parentIndex) => {
    // Re-chunking the parent's own text keeps every child a substring-by-content
    // of exactly one parent, which is what makes parent resolution unambiguous.
    const slices = chunkText(parent.text, {
      chunkSize: CHILD_CHUNK_SIZE,
      overlap: CHILD_OVERLAP,
    });

    // chunkText redacts and trims; a parent whose body survives as a single
    // short slice still yields one child, never zero.
    const effective = slices.length > 0 ? slices : [parent];

    for (const slice of effective) {
      children.push({
        ...slice,
        index: childIndex,
        section: slice.section ?? parent.section ?? null,
        parentIndex,
      });
      childIndex += 1;
    }
  });

  return { parents, children };
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
  chunk: Pick<Chunk, "index" | "charStart" | "charEnd"> & { section?: string | null };
  /** Channel-specific extras (media id, sender phone, original byte size…). */
  extra?: Record<string, unknown>;
  /** True for the large parent row (is_parent = true, embedding NULL). */
  isParent?: boolean;
}

export function buildChunkMetadata(input: ChunkMetadataInput): Record<string, unknown> {
  const section = input.chunk.section?.trim();
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
    // Both keys are added only when they apply, so the metadata of a document
    // ingested without sections or parents keeps the exact shape it had before
    // parent/child chunking existed.
    ...(section ? { section } : {}),
    ...(input.isParent ? { is_parent: true } : {}),
  };
}

/**
 * The text that is both embedded and stored for a chunk: contextual header
 * (document, classification level, section) followed by the chunk body.
 *
 * One definition shared by every ingestion path — HTTP upload, WhatsApp
 * document and reconciliation — so a reconciled document is retrieved exactly
 * like a freshly ingested one.
 */
export function withContextualHeader(
  chunk: Pick<Chunk, "text" | "section">,
  context: { filename: string; classificationLevel: PermissionLevel }
): string {
  return (
    buildContextualHeader({
      filename: context.filename,
      classificationLevel: context.classificationLevel,
      section: chunk.section,
    }) + chunk.text
  );
}

export interface ParentChildPlan {
  parents: Chunk[];
  children: ChildChunk[];
  /** Header-prefixed parent bodies, index-aligned with `parents`. */
  parentTexts: string[];
  /** Header-prefixed child bodies, index-aligned with `children`. */
  childTexts: string[];
}

/**
 * redactPii → small-to-big chunking → contextual header, in the order every
 * ingestion path applies them. `childTexts` is what gets embedded; both arrays
 * are what gets stored. Used by reconciliation so a repaired document is built
 * by exactly the same steps as a freshly ingested one.
 */
export function planParentChildChunks(input: {
  text: string;
  filename: string;
  classificationLevel: PermissionLevel;
  chunkOptions?: ChunkOptions;
}): ParentChildPlan {
  const { parents, children } = chunkTextParentChild(
    redactPii(input.text),
    input.chunkOptions
  );
  const headerContext = {
    filename: input.filename,
    classificationLevel: input.classificationLevel,
  };
  return {
    parents,
    children,
    parentTexts: parents.map((chunk) => withContextualHeader(chunk, headerContext)),
    childTexts: children.map((chunk) => withContextualHeader(chunk, headerContext)),
  };
}

export interface ParentChildRecordsInput {
  parents: readonly Chunk[];
  children: readonly ChildChunk[];
  /** Header-prefixed parent bodies, index-aligned with `parents`. */
  parentTexts: readonly string[];
  /** Header-prefixed child bodies, index-aligned with `children`. */
  childTexts: readonly string[];
  /** One embedding per CHILD, index-aligned with `children`. Parents get none. */
  vectors: readonly number[][];
  documentId: string;
  filename: string;
  mimeType: string;
  uploadedByUserId: string;
  classificationLevel: PermissionLevel;
  /** Channel-specific metadata merged into every row (see `buildChunkMetadata`). */
  extra?: Record<string, unknown>;
}

/**
 * Assembles the rows `insertDocumentWithChunks` and `backfillDocumentChunks`
 * persist: every parent first (embedding NULL), then every child carrying the
 * `parentIndex` of its parent within this same array.
 *
 * Parents must precede children — the self-referencing FK needs the parent row
 * inserted first, and `parentIndex` indexes into the returned array, so a
 * parent's position equals its index in `parents`.
 */
export function buildParentChildRecords(input: ParentChildRecordsInput): DocumentChunkRecord[] {
  if (input.vectors.length !== input.children.length) {
    throw new Error(
      `Embedding count mismatch: got ${input.vectors.length}, expected ${input.children.length}.`
    );
  }

  const metadataFor = (chunk: Chunk, isParent: boolean) =>
    buildChunkMetadata({
      documentId: input.documentId,
      filename: input.filename,
      mimeType: input.mimeType,
      uploadedByUserId: input.uploadedByUserId,
      classificationLevel: input.classificationLevel,
      chunk,
      ...(isParent ? { isParent: true } : {}),
      extra: input.extra,
    });

  return [
    ...input.parents.map(
      (chunk, i): DocumentChunkRecord => ({
        text: input.parentTexts[i]!,
        chunkIndex: chunk.index,
        metadata: metadataFor(chunk, true),
        embedding: null,
        isParent: true,
      })
    ),
    ...input.children.map(
      (chunk, i): DocumentChunkRecord => ({
        text: input.childTexts[i]!,
        chunkIndex: chunk.index,
        metadata: metadataFor(chunk, false),
        embedding: input.vectors[i]!,
        isParent: false,
        parentIndex: chunk.parentIndex,
      })
    ),
  ];
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
  /**
   * Cancellation from the caller — the HTTP request's own signal, so a client
   * that disconnects stops the embedding run instead of letting it finish and
   * bill for a document nobody is waiting on.
   */
  signal?: AbortSignal | null;
}

/**
 * The document produced more searchable chunks than a single ingestion may
 * embed. A caller-correctable condition (split the file), distinct from an
 * infrastructure failure, so the HTTP layer can answer it with a 4xx.
 */
export class DocumentLimitError extends Error {
  readonly chunkCount: number;
  readonly limit: number;

  constructor(chunkCount: number, limit: number) {
    super(`${chunkCount} chunks exceeds the ${limit}-chunk ceiling.`);
    this.name = "DocumentLimitError";
    this.chunkCount = chunkCount;
    this.limit = limit;
  }
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

  // Small-to-big: children are embedded and searched, parents are what the LLM
  // reads back. Both carry the contextual header, because `content_tsv` is
  // generated from `content` and the lexical leg must see it too.
  const { parents, children } = chunkTextParentChild(sanitized, input.chunkOptions);

  const headerContext = {
    filename: input.filename,
    classificationLevel: input.classificationLevel,
  };
  const parentTexts = parents.map((chunk) => withContextualHeader(chunk, headerContext));
  const childTexts = children.map((chunk) => withContextualHeader(chunk, headerContext));

  if (children.length === 0) {
    return { documentId, chunkCount: 0, insertedChunkIds: [], failures: [] };
  }

  // Same ceiling the WhatsApp path enforces (see extractChunks), applied to
  // SEARCHABLE chunks because those are what cost embedding quota. Checked
  // before any network call, so an oversized file fails in milliseconds and
  // spends nothing.
  if (children.length > MAX_CHUNKS_PER_DOCUMENT) {
    throw new DocumentLimitError(children.length, MAX_CHUNKS_PER_DOCUMENT);
  }

  // Only the children are embedded; parents are stored with embedding = NULL.
  // The header is part of the embedded string, which is the point of contextual
  // enrichment — the vector encodes the document and section, not just the slice.
  // Embedded in paced slices rather than one request: a single call carrying
  // every chunk is itself what exceeds the provider's batch limit and quota.
  const vectors = await embedChunksInBatches(childTexts, input.signal);

  if (vectors.length !== children.length) {
    throw new Error(
      `Embedding count mismatch: got ${vectors.length}, expected ${children.length}.`
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
    // Parents first (FK order); insertDocumentWithChunks asserts the ordering.
    chunks: buildParentChildRecords({
      parents,
      children,
      parentTexts,
      childTexts,
      vectors,
      documentId,
      filename: input.filename,
      mimeType: input.mimeType,
      uploadedByUserId: input.uploadedByUserId,
      classificationLevel: input.classificationLevel,
      extra: {
        source: input.source ?? "upload_api",
        ...(input.extraMetadata ?? {}),
      },
    }),
  });

  return {
    documentId: result.documentId,
    // The searchable chunk count, which is what every caller reports and what
    // ingested_documents.chunk_count has always meant. Parents are storage for
    // the generation step, not corpus entries in their own right.
    chunkCount: children.length,
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
const EMBED_BATCH_PAUSE_MS = parseNonNegativeInt(process.env.DOCUMENT_EMBED_BATCH_PAUSE_MS, 250);
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
async function embedChunksInBatches(
  texts: string[],
  signal?: AbortSignal | null
): Promise<number[][]> {
  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    if (signal?.aborted) {
      throw new Error("Document ingestion cancelled before embedding finished.");
    }

    // Takes finished strings, not Chunks: the contextual header is part of what
    // gets embedded, and building it needs the filename and classification
    // level that only the caller has.
    const slice = texts.slice(start, start + EMBED_BATCH_SIZE);
    const batch = await embedTextBatch(slice, signal ?? undefined);

    if (batch.length !== slice.length) {
      throw new Error(
        `Embedding count mismatch: got ${batch.length}, expected ${slice.length}.`
      );
    }

    vectors.push(...batch);

    const hasMore = start + EMBED_BATCH_SIZE < texts.length;
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
        senderId: redactPhone(event.senderId),
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
): Promise<{
  parents: Chunk[];
  children: ChildChunk[];
  sizeBytes: number;
  sha256: string | null;
}> {
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

  // REUSE: the Hebrew/Latin-aware semantic chunker, in small-to-big mode.
  const { parents, children } = chunkTextParentChild(redacted);

  if (children.length === 0) {
    throw new DocumentIngestionUserError(
      NO_TEXT_MESSAGE,
      `Chunking produced nothing usable for ${event.filename}.`
    );
  }

  // The ceiling counts SEARCHABLE chunks, so it keeps its original meaning
  // after parent/child chunking. Children are ~400 chars against the previous
  // ~1500, so a document near the old limit now yields roughly 3.5x as many —
  // the cap is applied to children deliberately, as that is what drives
  // embedding cost and index size.
  if (children.length > MAX_CHUNKS_PER_DOCUMENT) {
    throw new DocumentIngestionUserError(
      TOO_LARGE_MESSAGE,
      `${children.length} chunks exceeds the ${MAX_CHUNKS_PER_DOCUMENT}-chunk ceiling.`
    );
  }

  return {
    parents,
    children,
    sizeBytes: media.sizeBytes,
    sha256: media.sha256 ?? event.sha256,
  };
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
  const { parents, children, sizeBytes, sha256 } = await extractChunks(event, ctx);

  // Contextual header, applied before embedding and stored as part of `content`
  // so the generated `content_tsv` carries it into the lexical leg too.
  const headerContext = { filename: event.filename, classificationLevel };
  const parentTexts = parents.map((chunk) => withContextualHeader(chunk, headerContext));
  const childTexts = children.map((chunk) => withContextualHeader(chunk, headerContext));

  // ── STEP 3: embed in rate-limit-friendly batches ──────────────────────────
  // Children only — parent rows are stored with embedding = NULL.
  const vectors = await embedChunksInBatches(childTexts, ctx.signal);

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

  // Parents first — the FK needs them inserted before their children.
  const records: DocumentChunkRecord[] = buildParentChildRecords({
    parents,
    children,
    parentTexts,
    childTexts,
    vectors,
    documentId,
    filename: event.filename,
    mimeType: event.mimeType,
    uploadedByUserId: user.userId,
    classificationLevel,
    extra: chunkMetadata,
  });

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
    senderId: redactPhone(event.senderId),
    messageId: event.messageId,
    documentId: result.documentId,
    filename: event.filename,
    mimeType: event.mimeType,
    classificationLevel,
    chunkCount: children.length,
    insertedChunks: result.insertedChunkIds.length,
    alreadyIngested: result.alreadyIngested,
  });

  // ── STEP 5: close the loop ────────────────────────────────────────────────
  await reply(event.senderId, SUCCESS_MESSAGE, ctx.signal);
}

/**
 * Failure policy, deliberately identical in shape to the chat pipeline's
 * (see `handleProcessingFailure` in lib/domain/whatsapp/webhook.ts):
 *
 *   - user error       → one specific explanation, then resolve. No retry.
 *   - unique violation → an earlier attempt already committed; confirm success.
 *   - not the last try → stay silent and rethrow so BullMQ retries.
 *   - the last try     → notify once, then throw UserNotifiedFailureError so the
 *                        retry loop terminates and the job stays in `failed`.
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
      senderId: redactPhone(senderId),
      messageId,
      filename: event.filename,
      mimeType: event.mimeType,
    });
    await notify(event, err.reply, ctx);
    return;
  }

  // The document row is keyed on the Meta message id (migration 001), so a
  // duplicate means the work is already in the corpus. Confirming is correct;
  // retrying could only produce the same violation again.
  if (isUniqueViolation(err)) {
    logInfo("document_ingestion_duplicate_ignored", "Unique violation treated as success.", {
      senderId: redactPhone(senderId),
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
    senderId: redactPhone(senderId),
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

  // The admin has been told; end the retry loop but keep the failure on record.
  // UserNotifiedFailureError is unrecoverable, so BullMQ files the job under
  // `failed` rather than reporting a document that never landed as `completed`.
  throw new UserNotifiedFailureError(err);
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
      senderId: redactPhone(event.senderId),
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
 * A terminal failure throws UserNotifiedFailureError once the admin has been
 * told — see `handleIngestionFailure`.
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
