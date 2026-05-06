-- ============================================================
-- ScholarAgent — Initial database setup
-- Runs once on first container boot (when the volume is empty)
-- ============================================================

-- 1) Required extensions
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector for embedding similarity
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- needed for gen_random_uuid()

-- 2) Knowledge base table
--    Mirrors KNOWLEDGE_BASE_SCHEMA_SQL in lib/auth/rls.ts
CREATE TABLE IF NOT EXISTS knowledge_base (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content              TEXT NOT NULL,
  metadata             JSONB,
  classification_level INTEGER NOT NULL DEFAULT 4,
  embedding            vector(768),
  created_at           TIMESTAMPTZ DEFAULT now()
);

-- 3) Vector index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS knowledge_base_embedding_idx
  ON knowledge_base
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 4) B-tree index on classification_level so RLS filtering stays fast
CREATE INDEX IF NOT EXISTS knowledge_base_classification_idx
  ON knowledge_base (classification_level);

-- 5) Enable Row-Level Security and define the access policy
--    Rule: a row is visible only if its classification_level >= the
--    session's app.user_permission_level (lower number = higher privilege).
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_knowledge_access ON knowledge_base;
CREATE POLICY rls_knowledge_access ON knowledge_base
  FOR SELECT
  USING (
    classification_level >= current_setting('app.user_permission_level', true)::integer
  );

CREATE TABLE IF NOT EXISTS chat_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  message_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_history_sender_occurred_idx
  ON chat_history (sender_id, occurred_at ASC, created_at ASC);

-- 6) Default session parameter — fai