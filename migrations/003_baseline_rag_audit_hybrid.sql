-- Migration 003: Baseline RAG — audit logging, BM25/tsvector for hybrid retrieval
-- `simple` text search config: portable tokenisation for mixed Hebrew/Latin corpora
-- (no Hebrew stemmer in stock PostgreSQL; avoids English-centric stemming).

-- ── Full-text column (BM25 via ts_rank / ts_rank_cd) ─────────────────────────
ALTER TABLE knowledge_base
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS knowledge_base_content_tsv_gin_idx
  ON knowledge_base
  USING gin (content_tsv);

-- ── Audit trail for RAG queries (NGO / minors compliance) ───────────────────
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

INSERT INTO schema_migrations (version) VALUES ('003_baseline_rag_audit_hybrid')
  ON CONFLICT (version) DO NOTHING;
