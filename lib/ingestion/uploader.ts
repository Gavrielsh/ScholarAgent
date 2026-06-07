import { randomUUID } from "node:crypto";
import mammoth from "mammoth";
// pdf-parse v2 exports a class-based API with named exports (no default export).
// LoadParameters.data accepts Uint8Array | ArrayBuffer | Buffer.
// TextResult.text holds the concatenated text from all pages.
import { PDFParse } from "pdf-parse";

import type { PermissionLevel } from "@/lib/auth/types";
import { upsertDocumentsBatch, type EmbeddingRecord } from "@/lib/db/pgvector";
import { chunkText, type ChunkOptions } from "@/lib/ingestion/chunker";
import { embedTextBatch } from "@/lib/ingestion/embeddings";
import { redactPii } from "@/lib/ingestion/piiRedact";

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
  extraMetadata?: Record<string, unknown>;
  /** Override chunking parameters per document type (optional). */
  chunkOptions?: ChunkOptions;
}

export interface UploadDocumentResult {
  documentId: string;
  chunkCount: number;
  insertedChunkIds: string[];
  failures: Array<{ index: number; error: string }>;
}

// ---------------------------------------------------------------------------
// Core ingestion function
// ---------------------------------------------------------------------------

export async function ingestDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
  if (!input.text.trim()) {
    throw new Error("Cannot ingest a document with no extractable text.");
  }

  const documentId = randomUUID();
  const sanitized = redactPii(input.text);
  const chunks = chunkText(sanitized, input.chunkOptions);

  if (chunks.length === 0) {
    return { documentId, chunkCount: 0, insertedChunkIds: [], failures: [] };
  }

  const vectors = await embedTextBatch(chunks.map((c) => c.text));

  if (vectors.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch: got ${vectors.length}, expected ${chunks.length}.`
    );
  }

  const records: EmbeddingRecord[] = chunks.map((chunk, i) => ({
    text: chunk.text,
    classificationLevel: input.classificationLevel,
    embedding: vectors[i],
    metadata: {
      ...(input.extraMetadata ?? {}),
      document_id: documentId,
      filename: input.filename,
      mime_type: input.mimeType,
      uploaded_by: input.uploadedByUserId,
      // Mirrors classificationLevel so consumers can filter in SQL without joining.
      required_role: input.classificationLevel,
      chunk_index: chunk.index,
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
    },
  }));

  const { insertedIds, failures } = await upsertDocumentsBatch(records);

  return {
    documentId,
    chunkCount: chunks.length,
    insertedChunkIds: insertedIds,
    failures,
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
