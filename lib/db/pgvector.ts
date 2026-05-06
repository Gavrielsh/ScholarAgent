import { withClient, withRlsTransaction } from "@/lib/db/client";
import type { PermissionLevel } from "@/lib/auth/types";
import { embedText } from "@/lib/ingestion/embeddings";

const EMBEDDING_DIMENSION = 768;

export interface EmbeddingRecord {
  id?: string;
  text: string;
  classificationLevel: PermissionLevel;
  metadata?: Record<string, unknown>;
  // Precomputed embedding vector. When provided, embedText() is skipped,
  // eliminating the redundant API call from the batch-upload pipeline.
  embedding?: number[];
}

export interface SimilarDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown> | null;
  classificationLevel: PermissionLevel;
  similarity: number;
}

// Convert a JS number[] vector to the PostgreSQL pgvector literal: "[0.1,0.2,...]".
function toVectorLiteral(vector: number[]): string {
  if (vector.length === 0) {
    throw new Error("Cannot serialise an empty embedding vector.");
  }
  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding dimension mismatch: got ${vector.length}, expected ${EMBEDDING_DIMENSION}.`
    );
  }
  return `[${vector.join(",")}]`;
}

// Insert a chunk + its embedding. The classificationLevel determines who may
// later retrieve this row through the RLS policy.
export async function upsertDocument(document: EmbeddingRecord): Promise<string> {
  if (!document.text.trim()) {
    throw new Error("Cannot insert document with empty text.");
  }

  // Use the precomputed embedding when available (batch upload path) to avoid
  // a redundant Gemini API call per chunk. Fall back to on-demand embedding
  // for single-document inserts that don't pre-compute.
  const embedding =
    document.embedding && document.embedding.length > 0
      ? document.embedding
      : await embedText(document.text);

  if (embedding.length === 0) {
    throw new Error("Embedding generation returned an empty vector.");
  }

  const vectorLiteral = toVectorLiteral(embedding);
  const metadataJson = JSON.stringify(document.metadata ?? {});

  // INSERT ... RETURNING id. Uses the DB's gen_random_uuid() if no id supplied.
  // Writes bypass the RLS SELECT policy, but we still execute as a normal
  // pooled query — the upload endpoint enforces RBAC before reaching this.
  const sql = document.id
    ? `
        INSERT INTO knowledge_base (id, content, metadata, classification_level, embedding)
        VALUES ($1, $2, $3::jsonb, $4, $5::vector)
        ON CONFLICT (id) DO UPDATE
          SET content = EXCLUDED.content,
              metadata = EXCLUDED.metadata,
              classification_level = EXCLUDED.classification_level,
              embedding = EXCLUDED.embedding
        RETURNING id;
      `
    : `
        INSERT INTO knowledge_base (content, metadata, classification_level, embedding)
        VALUES ($1, $2::jsonb, $3, $4::vector)
        RETURNING id;
      `;

  const params = document.id
    ? [document.id, document.text, metadataJson, document.classificationLevel, vectorLiteral]
    : [document.text, metadataJson, document.classificationLevel, vectorLiteral];

  const result = await withClient((client) => client.query<{ id: string }>(sql, params));
  const insertedId = result.rows[0]?.id;
  if (!insertedId) {
    throw new Error("Document insert did not return an id.");
  }
  return insertedId;
}

// Insert many documents efficiently. Each row goes through the single-row
// upsert path so any individual failure is isolated. For very large batches,
// TODO: convert to a single COPY or multi-row INSERT for throughput.
export async function upsertDocumentsBatch(
  documents: EmbeddingRecord[]
): Promise<{ insertedIds: string[]; failures: Array<{ index: number; error: string }> }> {
  const insertedIds: string[] = [];
  const failures: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < documents.length; i++) {
    try {
      const id = await upsertDocument(documents[i]);
      insertedIds.push(id);
    } catch (err) {
      failures.push({
        index: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { insertedIds, failures };
}

// RLS-aware similarity search. The transaction sets app.user_permission_level
// so the policy filters out any row whose classification_level is below the
// user's authorisation. This is the database-level half of the defence-in-depth
// strategy described in the proposal.
export async function querySimilarDocuments(
  queryText: string,
  permissionLevel: PermissionLevel,
  limit = 5
): Promise<SimilarDocument[]> {
  if (!queryText.trim()) {
    return [];
  }

  const queryEmbedding = await embedText(queryText);
  if (queryEmbedding.length === 0) {
    return [];
  }

  const vectorLiteral = toVectorLiteral(queryEmbedding);

  const sql = `
    SELECT id, content, metadata, classification_level,
           1 - (embedding <=> $1::vector) AS similarity
    FROM knowledge_base
    ORDER BY embedding <=> $1::vector
    LIMIT $2;
  `;

  const result = await withRlsTransaction(permissionLevel, (client) =>
    client.query<{
      id: string;
      content: string;
      metadata: Record<string, unknown> | null;
      classification_level: PermissionLevel;
      similarity: number;
    }>(sql, [vectorLiteral, limit])
  );

  return result.rows.map((row) => ({
    id: row.id,
    text: row.content,
    metadata: row.metadata,
    classificationLevel: row.classification_level,
    similarity: Number(row.similarity),
  }));
}
