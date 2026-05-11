-- ============================================================
-- ScholarAgent — Initial database setup
-- This script synchronizes the local Docker environment with 
-- the project's security model and schema requirements.
-- ============================================================

-- 1) Required extensions
-- Install pgvector for vector similarity searches and pgcrypto for UUID generation.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2) Users table
-- Maps WhatsApp phone numbers to permission levels (L0-L3).
-- Essential for the lookupUserByPhone logic in the application.
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number     VARCHAR(20) UNIQUE NOT NULL, -- E.164 format
  permission_level INTEGER NOT NULL DEFAULT 3
                     CHECK (permission_level BETWEEN 0 AND 3),
  organization_id  UUID,
  display_name     TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- Index for fast user lookup by phone number during WhatsApp Webhook processing.
CREATE INDEX IF NOT EXISTS users_phone_number_idx ON users (phone_number);

-- 3) Knowledge base table
-- Stores document chunks and their corresponding Gemini embeddings (768 dimensions).
CREATE TABLE IF NOT EXISTS knowledge_base (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content              TEXT NOT NULL,
  metadata             JSONB,
  classification_level INTEGER NOT NULL DEFAULT 3
                         CHECK (classification_level BETWEEN 0 AND 3),
  embedding            vector(768), -- Dimension matches text-embedding-004
  created_at           TIMESTAMPTZ DEFAULT now()
);

-- 4) Vector Index (HNSW)
-- Using HNSW for high-performance approximate nearest neighbor search as per proposal.
CREATE INDEX IF NOT EXISTS knowledge_base_embedding_hnsw_idx
  ON knowledge_base
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Index on classification_level to optimize RLS filtering.
CREATE INDEX IF NOT EXISTS knowledge_base_classification_idx
  ON knowledge_base (classification_level);

-- 5) Row-Level Security (RLS)
-- Enforces the multi-layered security model at the database level.
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;

-- Policy: A row is only visible if its classification_level is >= the session's permission level.
-- (Lower numeric level = higher privilege).
DROP POLICY IF EXISTS rls_knowledge_access ON knowledge_base;
CREATE POLICY rls_knowledge_access ON knowledge_base
  FOR SELECT
  USING (
    classification_level >= current_setting('app.user_permission_level', true)::integer
  );

-- 6) Chat history table
-- Persists WhatsApp conversation turns for multi-turn context.
CREATE TABLE IF NOT EXISTS chat_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content     TEXT NOT NULL,
  message_id  TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for efficient history retrieval per sender, sorted by time.
CREATE INDEX IF NOT EXISTS chat_history_sender_occurred_idx
  ON chat_history (sender_id, occurred_at ASC, created_at ASC);

-- 7) Default session parameter
-- Fallback to the lowest registered level (3) if no permission level is explicitly set.
SELECT set_config('app.user_permission_level', '3', false);