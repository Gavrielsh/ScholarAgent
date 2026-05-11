-- Migration 001: initial schema
-- Run once against your PostgreSQL 16 instance:
--   psql $DATABASE_URL -f migrations/001_initial_schema.sql

-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- provides gen_random_uuid()

-- ── Users table ─────────────────────────────────────────────────────────────
-- Maps WhatsApp phone numbers to permission levels (L0-L3).
-- Populated manually or through an admin interface; not auto-created on first message.
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number     VARCHAR(20) UNIQUE NOT NULL,   -- E.164 format, e.g. "972501234567"
  permission_level INTEGER NOT NULL DEFAULT 3
                     CHECK (permission_level BETWEEN 0 AND 3),
  organization_id  UUID,
  display_name     TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_phone_number_idx ON users (phone_number);

-- ── Knowledge base table ─────────────────────────────────────────────────────
-- Stores document chunks + their Gemini text-embedding-004 vectors (768-dim).
-- Each chunk inherits a classification_level matching one of the four user tiers.
CREATE TABLE IF NOT EXISTS knowledge_base (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content              TEXT NOT NULL,
  metadata             JSONB,
  classification_level INTEGER NOT NULL DEFAULT 3
                         CHECK (classification_level BETWEEN 0 AND 3),
  -- DIMENSION: text-embedding-004 outputs 768 floats (not 1536).
  embedding            vector(768),
  created_at           TIMESTAMPTZ DEFAULT now()
);

-- HNSW index for approximate nearest-neighbour cosine search (proposal §5.2).
-- m=16 and ef_construction=64 are standard starting values; re-tune after indexing
-- the full corpus and running EXPLAIN ANALYZE on representative queries.
CREATE INDEX IF NOT EXISTS knowledge_base_embedding_hnsw_idx
  ON knowledge_base
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS knowledge_base_classification_idx
  ON knowledge_base (classification_level);

-- ── Row-Level Security ───────────────────────────────────────────────────────
-- Layer B of the dual-layer security model (proposal §7.1).
-- The application sets `app.user_permission_level` at the start of each
-- transaction via SET LOCAL before executing any SELECT.
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;

-- Allow bypass for superuser / migration scripts.
ALTER TABLE knowledge_base FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_knowledge_access ON knowledge_base;
CREATE POLICY rls_knowledge_access ON knowledge_base
  FOR SELECT
  USING (
    classification_level >= current_setting('app.user_permission_level', true)::integer
  );

-- INSERT/UPDATE/DELETE remain unrestricted at DB level; the upload endpoint
-- enforces RBAC (assertMinimumLevel) before any write reaches this table.

-- ── Migration tracking ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('001')
  ON CONFLICT (version) DO NOTHING;
