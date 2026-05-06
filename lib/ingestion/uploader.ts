import { randomUUID } from "node:crypto";
import mammoth from "mammoth";

import type { PermissionLevel } from "@/lib/auth/types";
import { upsertDocumentsBatch, type EmbeddingRecord } from "@/lib/db/pgvector";
import { chunkText } from "@/lib/ingestion/chunker";
import { embedTextBatch } from "@/lib/ingestion/embeddings";

export interface UploadDocumentInput {
  filename: string;
  mimeType: string;
  text: string;
  classificationLevel: PermissionLevel;
  uploadedByUserId: string;
  extraMetadata?: Record<string, unknown>;
}

export interface UploadDocumentResult {
  documentId: string;
  chunkCount: number;
  insertedChunkIds: string[];
  failures: Array<{ index: number; error: string }>;
}

// Orchestrates the full ingestion pipeline:
//   raw text → chunks → embeddings → DB rows (with classification level).
// Each chunk is inserted as its own knowledge_base row, all sharing a
// `documentId` in metadata so they can be grouped or deleted together.
export async function ingestDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
  if (!input.text.trim()) {
    throw new Error("Cannot ingest a document with no extractable text.");
  }

  const documentId = randomUUID();
  const chunks = chunkText(input.text);

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
    // Pass the precomputed vector so upsertDocument skips the redundant
    // embedText() call — one Gemini API round-trip per chunk instead of two.
    embedding: vectors[i],
    metadata: {
      ...(input.extraMetadata ?? {}),
      document_id: documentId,
      filename: input.filename,
      mime_type: input.mimeType,
      uploaded_by: input.uploadedByUserId,
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

// Decodes uploaded file bytes into UTF-8 text. PDF/DOCX extraction is left
// as a TODO so the basic text/markdown path stays dependency-free.
export async function extractTextFromUpload(
  bytes: ArrayBuffer,
  mimeType: string
): Promise<string> {
  switch (mimeType) {
    case "text/plain":
    case "text/markdown":
    case "text/csv":
      return new TextDecoder("utf-8").decode(bytes);

    case "application/pdf":
      {
        const parser = (await import("pdf-parse")) as unknown as {
          default?: (buf: Buffer) => Promise<{ text?: string }>;
        };
        const parsePdf = parser.default;
        if (!parsePdf) {
          throw new Error("מודול PDF לא נטען כראוי.");
        }
        return (await parsePdf(Buffer.from(bytes))).text ?? "";
      }

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value ?? "";

    default:
      throw new Error(`Unsupported MIME type for text extraction: ${mimeType}`);
  }
}
