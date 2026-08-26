-- =============================================================================
-- ScholarAgent — Canonical Baseline Schema
-- PostgreSQL 16 + pgvector
--
-- This file is the single source of truth for a fresh database. It is the
-- production schema as of the former incremental series 001–009 (last patch:
-- RLS tightening). Apply with:
--
--   npm run migrate
--   -- or --
--   psql $DATABASE_URL -f migrations/001_initial_schema.sql
--
-- Conventions
--   * Classification / permission integers: 0 = most privileged (Admin),
--     3 = least privileged (Volunteer). A row is visible when
--     classification_level >= session permission level.
--   * Embeddings are Gemini text-embedding-004: 768 dimensions, cosine
--     distance, HNSW index with vector_cosine_ops.
--   * Full-text uses the `simple` text-search configuration so mixed
--     Hebrew/Latin corpora are tokenised without English-centric stemming
--     (stock PostgreSQL has no Hebrew stemmer).
--   * Statements are idempotent (IF NOT EXISTS / DROP IF EXISTS) so the
--     file may be re-applied safely on an already-bootstrapped instance.
-- =============================================================================


-- =============================================================================
-- 1. Extensions & Schema Versioning
-- =============================================================================

-- pgvector: vector type, cosine operators, HNSW access method.
CREATE EXTENSION IF NOT EXISTS vector;

-- pgcrypto: gen_random_uuid() for primary keys.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tracks which migration files the runner (migrations/run.ts) has applied.
-- The runner keys off the SQL filename without the .sql suffix.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ DEFAULT now()
);


-- =============================================================================
-- 2. User Identity & Access Control
-- =============================================================================
-- Maps WhatsApp E.164 phone numbers to the four-tier RBAC model (L0–L3).
-- Rows are provisioned administratively; they are not created on first message.

CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number     VARCHAR(20) UNIQUE NOT NULL,  -- E.164, e.g. "972501234567"
  permission_level INTEGER NOT NULL DEFAULT 3
                     CONSTRAINT users_permission_level_check
                     CHECK (permission_level BETWEEN 0 AND 3),
  -- Retained: lib/security/auth/userRegistry.ts SELECTs this column into UserContext.
  -- It is optional (no FK); JWT user_metadata may also populate it.
  organization_id  UUID,
  display_name     TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- Webhook / lookupUserByPhone hot path.
CREATE INDEX IF NOT EXISTS users_phone_number_idx ON users (phone_number);


-- =============================================================================
-- 3. Knowledge Base & Vector Store (RAG Core)
-- =============================================================================
-- One row per embedded chunk. Retrieval (dense HNSW + BM25/tsvector hybrid),
-- classification RLS, and document-id bookkeeping all key off this table.

CREATE TABLE IF NOT EXISTS knowledge_base (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content              TEXT NOT NULL,
  metadata             JSONB,
  classification_level INTEGER NOT NULL DEFAULT 3
                         CONSTRAINT knowledge_base_classification_level_check
                         CHECK (classification_level BETWEEN 0 AND 3),
  -- DIMENSION: text-embedding-004 outputs 768 floats (not 1536).
  embedding            vector(768),
  -- Generated BM25 column for the lexical leg of hybrid search (ts_rank /
  -- ts_rank_cd). `simple` config: portable tokenisation, no stemming.
  content_tsv          tsvector GENERATED ALWAYS AS (
                         to_tsvector('simple', coalesce(content, ''))
                       ) STORED,
  created_at           TIMESTAMPTZ DEFAULT now()
);

-- Approximate nearest-neighbour cosine search. m=16 / ef_construction=64 are
-- the standard starting values; re-tune after indexing the full corpus.
CREATE INDEX IF NOT EXISTS knowledge_base_embedding_hnsw_idx
  ON knowledge_base
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Lexical (BM25) leg of hybrid retrieval.
CREATE INDEX IF NOT EXISTS knowledge_base_content_tsv_gin_idx
  ON knowledge_base
  USING gin (content_tsv);

-- Speeds RLS / classification filters on the dense and lexical paths.
CREATE INDEX IF NOT EXISTS knowledge_base_classification_idx
  ON knowledge_base (classification_level);

-- Chunk → document lookup. hardDeleteKnowledgeChunksByDocumentId() and the
-- cascade trigger filter on this exact expression; without it those deletes
-- sequential-scan the corpus.
CREATE INDEX IF NOT EXISTS knowledge_base_document_id_idx
  ON knowledge_base ((metadata->>'document_id'));


-- =============================================================================
-- 4. Document Ingestion Provenance
-- =============================================================================
-- One row per logical document (WhatsApp upload or HTTP API). Chunks remain
-- in knowledge_base; this registry answers "who uploaded this, from which
-- channel, at what classification, how many chunks" and makes retried
-- ingestion idempotent via external_message_id.

CREATE TABLE IF NOT EXISTS ingested_documents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'whatsapp' | 'upload_api' | future channels.
  source               TEXT NOT NULL DEFAULT 'whatsapp',
  filename             TEXT NOT NULL,
  mime_type            TEXT NOT NULL,
  size_bytes           BIGINT,
  sha256               TEXT,
  -- Meta media handle and inbound message id. TEXT, not UUID: these are
  -- opaque vendor identifiers (`wamid.HBgL...`), not our own keys.
  external_media_id    TEXT,
  external_message_id  TEXT,
  -- users.id for the WhatsApp path; Supabase `sub` claim for the HTTP path.
  uploaded_by_user_id  TEXT NOT NULL,
  uploaded_by_phone    TEXT,
  classification_level INTEGER NOT NULL DEFAULT 3
                         CONSTRAINT ingested_documents_classification_level_check
                         CHECK (classification_level BETWEEN 0 AND 3),
  chunk_count          INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'ingested',
  metadata             JSONB,
  created_at           TIMESTAMPTZ DEFAULT now()
);

-- Idempotency key for the WhatsApp pipeline. A BullMQ job that commits and
-- then dies before sending the WhatsApp confirmation is retried; without this
-- the same document would be embedded twice. Partial: HTTP upload rows carry
-- no external_message_id and must not collide with each other.
-- Named `_key` so ON CONFLICT inference in lib/core/db/pgvector.ts resolves.
CREATE UNIQUE INDEX IF NOT EXISTS ingested_documents_external_message_id_key
  ON ingested_documents (external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ingested_documents_uploaded_by_idx
  ON ingested_documents (uploaded_by_user_id);

CREATE INDEX IF NOT EXISTS ingested_documents_created_at_idx
  ON ingested_documents (created_at DESC);


-- =============================================================================
-- 5. WhatsApp Chat History (Multi-Turn Context)
-- =============================================================================
-- Persistent conversation turns. sender_id is the WhatsApp E.164 phone number
-- (session key). Replaces ephemeral filesystem storage.

CREATE TABLE IF NOT EXISTS chat_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id   TEXT NOT NULL,
  role        TEXT NOT NULL
                CONSTRAINT chat_history_role_check
                CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  message_id  TEXT,                          -- Meta message id (dedup / audit)
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Own-history reads: chronological window per sender.
CREATE INDEX IF NOT EXISTS chat_history_sender_occurred_idx
  ON chat_history (sender_id, occurred_at ASC, created_at ASC);

-- Recent-first listing per sender.
CREATE INDEX IF NOT EXISTS chat_history_sender_created_idx
  ON chat_history (sender_id, created_at DESC);

-- Makes chat_history writes idempotent under BullMQ retries. Partial: assistant
-- rows typically have no Meta message id and stay out of the index. Named `_key`
-- so ON CONFLICT inference in lib/domain/chat/session/history.ts resolves.
CREATE UNIQUE INDEX IF NOT EXISTS chat_history_message_id_key
  ON chat_history (message_id)
  WHERE message_id IS NOT NULL;


-- =============================================================================
-- 6. Audit & Compliance Logging
-- =============================================================================
-- RAG query trail (NGO / minors compliance): who asked what, which chunks
-- were retrieved, and how long the round trip took. No RLS — application
-- code is the only writer; this is an append-only operational log.

CREATE TABLE IF NOT EXISTS audit_logs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query                 TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  retrieved_chunk_ids   UUID[],
  latency_ms            INTEGER NOT NULL,
  created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at);


-- =============================================================================
-- 7. Functions & Cascade Triggers
-- =============================================================================
-- ingested_documents.id and knowledge_base.metadata->>'document_id' hold the
-- same value, but a JSONB key cannot carry a foreign key. Deleting a registry
-- row must retract its chunks, otherwise they remain fully retrievable by RAG
-- with no bookkeeping that still knows about the document.
--
-- SECURITY DEFINER: knowledge_base is FORCE ROW LEVEL SECURITY, so the
-- cascade is subject to policies even for the table owner. The function sets
-- app.user_permission_level = '0' so the tightened DELETE policy allows the
-- chunk retract. search_path is pinned to block search_path shadowing of
-- knowledge_base (a privilege-escalation vector for SECURITY DEFINER).

CREATE OR REPLACE FUNCTION delete_knowledge_chunks_for_document()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM set_config('app.user_permission_level', '0', true);
  DELETE FROM knowledge_base
   WHERE metadata->>'document_id' = OLD.id::text;
  -- AFTER ... FOR EACH ROW: return value is ignored.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION delete_knowledge_chunks_for_document() IS
  'Retracts every knowledge_base chunk tagged with the deleted document''s id.';

-- AFTER, not BEFORE: chunks are retracted only once the registry row is
-- actually gone, so a constraint abort cannot leave the corpus trimmed for a
-- document that still exists. FOR EACH ROW: one indexed delete per document.
DROP TRIGGER IF EXISTS trg_ingested_documents_cascade_chunks ON ingested_documents;
CREATE TRIGGER trg_ingested_documents_cascade_chunks
  AFTER DELETE ON ingested_documents
  FOR EACH ROW
  EXECUTE FUNCTION delete_knowledge_chunks_for_document();


-- =============================================================================
-- 8. Row-Level Security (RLS) — Tightened State
-- =============================================================================
-- Dual-layer model: application RBAC (assertMinimumLevel / writePermissionLevel)
-- plus these database policies. FORCE RLS applies policies to the table owner
-- as well (superuser / BYPASSRLS still bypass).
--
-- Session GUCs (SET LOCAL / set_config(..., true) inside a transaction):
--   app.user_permission_level  — integer 0..3 as text
--   app.sender_id              — E.164 phone; own-history chat_history path
--
-- Unset / empty GUCs no longer open SELECT or write. Callers must set the
-- relevant GUC (withRlsTransaction, withSenderTransaction, or an explicit
-- set_config in the ingestion transaction).

-- ── knowledge_base ──────────────────────────────────────────────────────────

ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base FORCE ROW LEVEL SECURITY;

-- Visible when the chunk is at or below the caller's privilege
-- (lower number = more privileged).
DROP POLICY IF EXISTS rls_knowledge_access ON knowledge_base;
CREATE POLICY rls_knowledge_access ON knowledge_base
  FOR SELECT
  USING (
    classification_level >= current_setting('app.user_permission_level', true)::integer
  );

-- Corpus writes require L0 (Admin) or L1 (Manager).
DROP POLICY IF EXISTS rls_knowledge_base_insert ON knowledge_base;
CREATE POLICY rls_knowledge_base_insert ON knowledge_base
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_permission_level', true) IS NOT NULL
    AND current_setting('app.user_permission_level', true)::integer IN (0, 1)
  );

DROP POLICY IF EXISTS rls_knowledge_base_update ON knowledge_base;
CREATE POLICY rls_knowledge_base_update ON knowledge_base
  FOR UPDATE
  USING (
    current_setting('app.user_permission_level', true) IS NOT NULL
    AND current_setting('app.user_permission_level', true)::integer IN (0, 1)
  )
  WITH CHECK (
    current_setting('app.user_permission_level', true) IS NOT NULL
    AND current_setting('app.user_permission_level', true)::integer IN (0, 1)
  );

DROP POLICY IF EXISTS rls_knowledge_base_delete ON knowledge_base;
CREATE POLICY rls_knowledge_base_delete ON knowledge_base
  FOR DELETE
  USING (
    current_setting('app.user_permission_level', true) IS NOT NULL
    AND current_setting('app.user_permission_level', true)::integer IN (0, 1)
  );

-- ── ingested_documents ──────────────────────────────────────────────────────

ALTER TABLE ingested_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingested_documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_ingested_documents_select ON ingested_documents;
CREATE POLICY rls_ingested_documents_select ON ingested_documents
  FOR SELECT
  USING (
    current_setting('app.user_permission_level', true) IS NOT NULL
    AND current_setting('app.user_permission_level', true) <> ''
    AND classification_level >= current_setting('app.user_permission_level', true)::integer
  );

DROP POLICY IF EXISTS rls_ingested_documents_insert ON ingested_documents;
CREATE POLICY rls_ingested_documents_insert ON ingested_documents
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_permission_level', true) IS NOT NULL
    AND current_setting('app.user_permission_level', true)::integer IN (0, 1)
  );

DROP POLICY IF EXISTS rls_ingested_documents_update ON ingested_documents;
CREATE POLICY rls_ingested_documents_update ON ingested_documents
  FOR UPDATE
  USING (
    current_setting('app.user_permission_level', true) IS NOT NULL
    AND current_setting('app.user_permission_level', true)::integer IN (0, 1)
  )
  WITH CHECK (
    current_setting('app.user_permission_level', true) IS NOT NULL
    AND current_setting('app.user_permission_level', true)::integer IN (0, 1)
  );

DROP POLICY IF EXISTS rls_ingested_documents_delete ON ingested_documents;
CREATE POLICY rls_ingested_documents_delete ON ingested_documents
  FOR DELETE
  USING (
    current_setting('app.user_permission_level', true) IS NOT NULL
    AND current_setting('app.user_permission_level', true)::integer IN (0, 1)
  );

-- ── chat_history ────────────────────────────────────────────────────────────
-- SELECT: own rows when app.sender_id is set; full bypass for L0; L2/L3
-- sender scope for any other session that set app.user_permission_level
-- (admin staff reports). INSERT: only the sender identified by app.sender_id.

ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_chat_history_select ON chat_history;
CREATE POLICY rls_chat_history_select ON chat_history
  FOR SELECT
  USING (
    (
      nullif(current_setting('app.sender_id', true), '') IS NOT NULL
      AND sender_id = current_setting('app.sender_id', true)
    )
    OR current_setting('app.user_permission_level', true) = '0'
    OR (
      current_setting('app.user_permission_level', true) IS NOT NULL
      AND current_setting('app.user_permission_level', true) <> ''
      AND EXISTS (
        SELECT 1 FROM users u
         WHERE u.phone_number = chat_history.sender_id
           AND u.permission_level = ANY(ARRAY[2, 3])
      )
    )
  );

DROP POLICY IF EXISTS rls_chat_history_insert ON chat_history;
CREATE POLICY rls_chat_history_insert ON chat_history
  FOR INSERT
  WITH CHECK (
    nullif(current_setting('app.sender_id', true), '') IS NOT NULL
    AND sender_id = current_setting('app.sender_id', true)
  );


-- =============================================================================
-- Schema version stamp
-- =============================================================================
-- Must match the SQL filename without .sql — migrations/run.ts uses that as
-- the version key.

INSERT INTO schema_migrations (version) VALUES ('001_initial_schema')
  ON CONFLICT (version) DO NOTHING;
