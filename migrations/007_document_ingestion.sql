-- Migration 007: document ingestion provenance for the WhatsApp upload pipeline.
--
-- The chunks themselves keep living in knowledge_base — retrieval, RLS, the
-- HNSW index and the BM25 leg from migration 003 all key off that one table and
-- splitting it would fork the RAG path. What was missing is a row per *logical
-- document*: who sent it, from which channel, at what classification, and how
-- many chunks it produced. Without it there is no way to answer "which admin
-- uploaded this?" or to make a retried ingestion idempotent.

-- ── Document registry ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingested_documents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'whatsapp' | 'upload_api' | future channels.
  source               TEXT NOT NULL DEFAULT 'whatsapp',
  filename             TEXT NOT NULL,
  mime_type            TEXT NOT NULL,
  size_bytes           BIGINT,
  sha256               TEXT,
  -- Meta's media handle and inbound message id. TEXT, not UUID: these are
  -- opaque vendor identifiers (`wamid.HBgL...`), not our own keys.
  external_media_id    TEXT,
  external_message_id  TEXT,
  -- users.id for the WhatsApp path, the Supabase `sub` claim for the HTTP path.
  uploaded_by_user_id  TEXT NOT NULL,
  uploaded_by_phone    TEXT,
  classification_level INTEGER NOT NULL DEFAULT 3
                         CHECK (classification_level BETWEEN 0 AND 3),
  chunk_count          INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'ingested',
  metadata             JSONB,
  created_at           TIMESTAMPTZ DEFAULT now()
);

-- Idempotency key for the pipeline.
--
-- A BullMQ job that commits the transaction and then dies before its WhatsApp
-- confirmation is sent will be retried, and without this the same document is
-- embedded and stored a second time — doubling the corpus and the Gemini bill.
-- Partial (same reasoning as migration 006): rows from the HTTP upload path
-- carry no external_message_id and must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS ingested_documents_external_message_id_key
  ON ingested_documents (external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ingested_documents_uploaded_by_idx
  ON ingested_documents (uploaded_by_user_id);
CREATE INDEX IF NOT EXISTS ingested_documents_created_at_idx
  ON ingested_documents (created_at DESC);

-- ── Chunk → document lookup ─────────────────────────────────────────────────
-- hardDeleteKnowledgeChunksByDocumentId() in lib/db/pgvector.ts filters on this
-- exact expression; without the index it is a sequential scan over the corpus.
CREATE INDEX IF NOT EXISTS knowledge_base_document_id_idx
  ON knowledge_base ((metadata->>'document_id'));

-- ── Row-Level Security ──────────────────────────────────────────────────────
-- Same rule as knowledge_base: a row is visible when its classification is at or
-- below the caller's privilege (lower number = more privileged).
ALTER TABLE ingested_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_ingested_documents_select ON ingested_documents;
CREATE POLICY rls_ingested_documents_select ON ingested_documents
  FOR SELECT
  USING (
    current_setting('app.user_permission_level', true) IS NULL
    OR classification_level >= current_setting('app.user_permission_level', true)::integer
  );

DROP POLICY IF EXISTS rls_ingested_documents_insert ON ingested_documents;
CREATE POLICY rls_ingested_documents_insert ON ingested_documents
  FOR INSERT
  WITH CHECK (true);

-- knowledge_base was created with FORCE ROW LEVEL SECURITY and a SELECT policy
-- only (migration 001). FORCE applies to the table owner as well, so with no
-- INSERT policy every write is rejected for any role that is not a superuser or
-- BYPASSRLS — the ingestion transaction below is exactly such a write. This
-- makes migration 001's stated intent ("INSERT/UPDATE/DELETE remain unrestricted
-- at DB level; the application enforces RBAC before any write") actually true,
-- and mirrors what migration 005 already does for chat_history.
DROP POLICY IF EXISTS rls_knowledge_base_insert ON knowledge_base;
CREATE POLICY rls_knowledge_base_insert ON knowledge_base
  FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS rls_knowledge_base_update ON knowledge_base;
CREATE POLICY rls_knowledge_base_update ON knowledge_base
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS rls_knowledge_base_delete ON knowledge_base;
CREATE POLICY rls_knowledge_base_delete ON knowledge_base
  FOR DELETE
  USING (true);

INSERT INTO schema_migrations (version) VALUES ('007_document_ingestion')
  ON CONFLICT (version) DO NOTHING;
