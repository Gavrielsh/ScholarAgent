import { randomUUID } from "node:crypto";
import mammoth from "mammoth";

// אומרים ל-TypeScript להתעלם משגיאת הטיפוסים של הספרייה המיושנת
// @ts-ignore
import pdfParse from "pdf-parse";

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
      try {
        const buffer = Buffer.from(bytes);
        
        // מוודא שאנחנו תופסים את הפונקציה הנכונה, לא משנה איך המערכת יבאה אותה
        const parse = typeof pdfParse === 'function' ? pdfParse : (pdfParse as any).default;
        
        if (!parse || typeof parse !== 'function') {
           throw new Error("פונקציית החילוץ לא נמצאה בתוך המודול.");
        }

        const data = await parse(buffer);
        return data.text ?? "";
      } catch (error) {
        console.error("PDF Parsing Error:", error);
        throw new Error(`מודול PDF לא נטען כראוי: ${error}`);
      }

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value ?? "";

    default:
      throw new Error(`Unsupported MIME type for text extraction: ${mimeType}`);
  }
}