import type { PermissionLevel } from "@/lib/security/auth/types";
import type { Chunk } from "@/lib/domain/ingestion/processor/chunker";

/**
 * The metadata contract for a knowledge_base row.
 *
 * Every ingestion path (HTTP upload, WhatsApp document) writes through here so
 * the JSONB shape stays identical. Downstream code depends on specific keys —
 * `hardDeleteKnowledgeChunksByDocumentId` filters on `document_id`, and the
 * admin reports read `uploaded_by` — so a path that spelled one of them
 * differently would silently opt its own rows out of those operations.
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
