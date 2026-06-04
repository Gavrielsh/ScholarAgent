import { randomUUID } from "node:crypto";
import mammoth from "mammoth";

import type { PermissionLevel } from "@/lib/auth/types";
import { upsertDocumentsBatch, type EmbeddingRecord } from "@/lib/db/pgvector";
import { chunkText } from "@/lib/ingestion/chunker";
import { embedTextBatch } from "@/lib/ingestion/embeddings";
import { redactPii } from "@/lib/ingestion/piiRedact";

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

export async function ingestDocument(input: UploadDocumentInput): Promise<UploadDocumentResult> {
  if (!input.text.trim()) {
    throw new Error("Cannot ingest a document with no extractable text.");
  }

  const documentId = randomUUID();
  const sanitized = redactPii(input.text);
  const chunks = chunkText(sanitized);

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

type TextExtractor = (bytes: ArrayBuffer) => Promise<string>;

const EXTRACTORS: Record<string, TextExtractor> = {
  "text/plain": async (bytes) => new TextDecoder("utf-8").decode(bytes),
  "text/markdown": async (bytes) => new TextDecoder("utf-8").decode(bytes),
  "text/csv": async (bytes) => new TextDecoder("utf-8").decode(bytes),

  "application/pdf": async (bytes) => {
    // pdf-parse v2 exports a PDFParse class — there is no default callable function.
    // Uint8Array is preferred: TypedArrays are transferred to the pdfjs worker,
    // reducing main-thread memory pressure.
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const { text } = await parser.getText();
      return text ?? "";
    } finally {
      // destroy() releases the underlying pdfjs DocumentLoadingTask and worker —
      // critical when processing many files in a batch to avoid resource leaks.
      await parser.destroy();
    }
  },

  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    async (bytes) =>
      (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value ?? "",
};

export async function extractTextFromUpload(
  bytes: ArrayBuffer,
  mimeType: string
): Promise<string> {
  const extractor = EXTRACTORS[mimeType];
  if (!extractor) {
    throw new Error(`Unsupported MIME type for text extraction: ${mimeType}`);
  }
  return extractor(bytes);
}
