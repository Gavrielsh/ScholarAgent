-- =============================================================================
-- ScholarAgent — Knowledge Gaps (flywheel, phase 1: detect + persist)
--
-- Records the questions the system could not answer from its own corpus, so the
-- organisation can see where its knowledge base is thin and close those gaps
-- with expert elicitation.
--
-- Phase 1 only writes. Nothing reads this table yet, and no user-visible
-- behaviour changes. Clustering, expert routing and ingestion land in later
-- migrations once two weeks of real rows have shown that detection fires on
-- recognisably real gaps.
--
-- Conventions follow 001_initial_schema.sql: 0 = most privileged, embeddings
-- are 768-dimension Gemini text-embedding-004 under cosine distance, and every
-- statement is idempotent so the file may be re-applied safely.
-- =============================================================================


-- =============================================================================
-- 1. Retrieval confidence on the audit trail
-- =============================================================================
-- audit_logs already records WHICH chunks were retrieved, but not how well they
-- matched, so "the corpus had nothing good for this" was unrecoverable after the
-- fact. Without this column the historical traffic already in the table cannot
-- be mined for gaps — only new rows would be usable.
--
-- NULL means no chunk was retrieved at all, which is distinct from a retrieval
-- that returned poor matches. Both are gaps; they are not the same gap.
--
-- SCALE HAZARD — read before thresholding this column. SimilarDocument.similarity
-- carries `1 - (embedding <=> query)` for the dense arm but `ts_rank_cd(...)` for
-- the lexical arm (lib/core/db.ts, the two `AS similarity` expressions). RRF sorts
-- the merged list by rrfScore and leaves `similarity` as whatever its source arm
-- produced, so the stored value is one of two incomparable scales and the row does
-- not record which. A cosine of 0.08 is a terrible match; a ts_rank_cd of 0.08 can
-- be an excellent one. Store it for analysis, do not compare it across rows, and
-- do not derive a confidence floor from it until the retrieval arm is recorded too.

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS max_similarity REAL;


-- =============================================================================
-- 2. Knowledge gaps
-- =============================================================================

CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- PII-redacted question text, as persisted to chat_history. Never the
  -- pre-redaction command text: a gap row is read by managers, and the asker's
  -- phrasing may name a child.
  question               TEXT NOT NULL,

  -- WhatsApp sender id, matching chat_history.sender_id. Kept so that a cluster
  -- can count DISTINCT askers; reports expose the count, never the identity.
  asker_id               TEXT NOT NULL,
  asker_permission_level INTEGER
                           CONSTRAINT knowledge_gaps_asker_level_check
                           CHECK (asker_permission_level BETWEEN 0 AND 3),

  -- Which detector fired. Recorded per row rather than collapsed to a boolean
  -- because phase 1 exists to find out which signal is trustworthy:
  --   model_declared_insufficient — the model said so itself after seeing the
  --                                 context. A semantic judgement, not a proxy.
  --   empty_retrieval             — nothing was retrieved at all.
  --   low_confidence              — RESERVED, not emitted in phase 1. A score
  --                                 floor is unsound while `similarity` mixes
  --                                 cosine and ts_rank_cd on one field; see the
  --                                 scale hazard above. Kept in the constraint so
  --                                 phase 2 can add it without a migration once
  --                                 the retrieval arm is recorded.
  signal                 TEXT NOT NULL
                           CONSTRAINT knowledge_gaps_signal_check
                           CHECK (signal IN (
                             'model_declared_insufficient',
                             'empty_retrieval',
                             'low_confidence'
                           )),

  -- NULL when nothing was retrieved. See the note on audit_logs.max_similarity.
  max_similarity         REAL,
  retrieved_count        INTEGER NOT NULL DEFAULT 0,

  -- Populated in phase 2 for clustering. Nullable so phase 1 can record gaps
  -- without paying an embedding call per miss.
  embedding              vector(768),
  cluster_id             UUID,

  status                 TEXT NOT NULL DEFAULT 'open'
                           CONSTRAINT knowledge_gaps_status_check
                           CHECK (status IN (
                             'open', 'routed', 'answered',
                             'approved', 'rejected', 'wont_fix'
                           )),

  -- Meta message id. Makes the write idempotent under BullMQ retries, the same
  -- way chat_history.message_id does.
  message_id             TEXT,

  occurred_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A retried job must not record the same miss twice and inflate a cluster's
-- distinct-asker count. Partial, because a gap detected outside a WhatsApp turn
-- (a backfill over historical audit_logs) legitimately has no Meta id.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_gaps_message_id_key
  ON knowledge_gaps (message_id)
  WHERE message_id IS NOT NULL;

-- Triage listing: open gaps, newest first.
CREATE INDEX IF NOT EXISTS knowledge_gaps_status_occurred_idx
  ON knowledge_gaps (status, occurred_at DESC);

-- Per-cluster rollups once phase 2 assigns cluster ids.
CREATE INDEX IF NOT EXISTS knowledge_gaps_cluster_idx
  ON knowledge_gaps (cluster_id)
  WHERE cluster_id IS NOT NULL;

-- Nearest-neighbour search for clustering. Partial: rows are embedded lazily,
-- and an HNSW index cannot hold NULL vectors.
CREATE INDEX IF NOT EXISTS knowledge_gaps_embedding_hnsw_idx
  ON knowledge_gaps
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;


-- =============================================================================
-- 3. Access
-- =============================================================================
-- No RLS, mirroring audit_logs: the application is the only writer, and phase 1
-- has no reader at all. This is a deliberate deferral, not an oversight.
--
-- Revisit when the reporting layer lands. A gap row holds a volunteer's own
-- words, and although PII is redacted before storage, a table of "what people
-- could not get answers about" is not something every tier should read. The
-- reporting layer is where the access decision belongs, because that is the
-- first point at which there is a reader to decide about.
-- =============================================================================
