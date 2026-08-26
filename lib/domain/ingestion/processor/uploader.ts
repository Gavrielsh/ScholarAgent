import { randomUUID } from "node:crypto";
import mammoth from "mammoth";
// pdf-parse v2 exports a class-based API with named exports (no default export).
// LoadParameters.data accepts Uint8Array | ArrayBuffer | Buffer.
// TextResult.text holds the concatenated text from all pages.
import { PDFParse } from "pdf-parse";

import { MANAGER_PERMISSION_LEVEL } from "@/lib/security/auth/rls";
import type { PermissionLevel } from "@/lib/security/auth/types";
import { insertDocumentWithChunks } from "@/lib/core/db";
import { buildChunkMetadata } from "@/lib/domain/ingestion/processor/chunkMetadata";
import { chunkText, type ChunkOptions } from "@/lib/domain/ingestion/processor/chunker";
import { embedTextBatch } from "@/lib/domain/ingestion/processor/embeddings";
import { redactPii } from "@/lib/security/privacy/piiRedact";

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
