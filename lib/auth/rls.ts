import type { PermissionLevel } from "@/lib/auth/types";

// Builds the WHERE clause fragment that enforces Row-Level Security.
// Assumes the knowledge_base table has a `classification_level` integer column.
//
// Rule: a row is visible when classification_level >= user's permission level.
// Admin (L0) → classification_level >= 0 → sees everything.
// Volunteer (L3) → classification_level >= 3 → sees only the lowest registered tier.
export function buildRlsWhereClause(permissionLevel: PermissionLevel): string {
  return `classification_level >= ${permissionLevel}`;
}

// Returns the full RLS-aware similarity search query.
// Parameterised: $1 = query embedding vector, $2 = result limit.
export function buildRlsVectorSearchSql(permissionLevel: PermissionLevel): string {
  return `
    SELECT id, content, metadata, classification_level,
           1 - (embedding <=> $1::vector) AS similarity
    FROM knowledge_base
    WHERE ${buildRlsWhereClause(permissionLevel)}
    ORDER BY embedding <=> $1::vector
    LIMIT $2;
  `.trim();
}

// Schema definition for the knowledge_base table (for reference; run via migrations/).
//
// DIMENSION NOTE: text-embedding-004 (Gemini free tier) outputs 768-dim vectors.
// The column must be vector(768) — NOT vector(1536) which is OpenAI's dimension.
export const KNOWLEDGE_BASE_SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE IF NOT EXISTS knowledge_base (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content              TEXT NOT NULL,
    metadata             JSONB,
    classification_level INTEGER NOT NULL DEFAULT 3
                           CHECK (classification_level BETWEEN 0 AND 3),
    embedding            vector(768),
    created_at           TIMESTAMPTZ DEFAULT now()
  );

  -- HNSW index for approximate nearest-neighbour search (proposal §5.2).
  -- m=16 and ef_construction=64 are sensible defaults; tune after load testing.
  CREATE INDEX IF NOT EXISTS knowledge_base_embedding_hnsw_idx
    ON knowledge_base
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

  -- RLS policy: each row is visible only to sessions where
  -- app.user_permission_level <= classification_level.
  ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS rls_knowledge_access ON knowledge_base;
  CREATE POLICY rls_knowledge_access ON knowledge_base
    FOR SELECT
    USING (
      classification_level >= current_setting('app.user_permission_level')::integer
    );
`.trim();

