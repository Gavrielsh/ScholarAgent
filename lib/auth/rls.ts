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

// The requester permission level that grants a full RLS bypass on chat_history
// (see CHAT_HISTORY_RLS_SCHEMA_SQL) and the admin-only repository functions in
// lib/chat/adminHistory.ts. Centralised here so "what counts as admin" is defined
// once, not re-hardcoded as a magic `0` across call sites.
export const ADMIN_PERMISSION_LEVEL: PermissionLevel = 0;

// Schema definition for the chat_history RLS policy (for reference; run via
// migrations/005_chat_history_rls.sql). Applied via withRlsTransaction(), which sets
// app.user_permission_level per-transaction before the admin report queries run.
//
// Design note: sessions that never set app.user_permission_level (plain withClient
// calls used for chat persistence / a user's own conversational context) are left
// unrestricted by the `IS NULL` clause below — this policy is additive defense-in-depth
// on top of the app-level filter in adminHistory.ts, not a replacement for it, and must
// never block ordinary message read/write traffic.
export const CHAT_HISTORY_RLS_SCHEMA_SQL = `
  ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chat_history FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS rls_chat_history_select ON chat_history;
  CREATE POLICY rls_chat_history_select ON chat_history
    FOR SELECT
    USING (
      current_setting('app.user_permission_level', true) IS NULL
      OR current_setting('app.user_permission_level', true)::integer = 0
      OR EXISTS (
        SELECT 1 FROM users u
         WHERE u.phone_number = chat_history.sender_id
           AND u.permission_level = ANY(ARRAY[2, 3])
      )
    );

  DROP POLICY IF EXISTS rls_chat_history_insert ON chat_history;
  CREATE POLICY rls_chat_history_insert ON chat_history
    FOR INSERT
    WITH CHECK (true);
`.trim();

