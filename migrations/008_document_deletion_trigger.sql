-- Migration 008: deleting a document row removes its chunks from the corpus.
--
-- ingested_documents.id and knowledge_base.metadata->>'document_id' hold the same
-- value, but a JSONB key cannot carry a foreign key, so nothing at the database
-- level ties a registry row to the content it produced. Today the only thing that
-- removes chunks is hardDeleteKnowledgeChunksByDocumentId() (lib/db/pgvector.ts),
-- reached exclusively through the document-deleted webhook. Every other path that
-- can remove a registry row — an admin running DELETE by hand, a retention job, a
-- cascade from a future parent table — leaves the chunks behind, and an orphaned
-- chunk is the worst possible state: still fully retrievable by RAG, no longer
-- visible to any bookkeeping that reasons about documents.
--
-- After this migration, deleting the document row is the single action that
-- retracts its content, whichever client issues it.
--
-- NOT DONE HERE, deliberately: a one-off sweep of chunks whose document_id has no
-- matching ingested_documents row. Chunks written by ingestDocument() — the HTTP
-- upload route and scripts/ingest_directory.ts — carry a document_id that was
-- never registered at all, so such a sweep would delete most of the corpus.
-- scripts/reconcile_documents.ts handles the inverse (registered, unembedded)
-- direction, which is the one that is safe to automate.

-- ── Index the trigger depends on ────────────────────────────────────────────
-- Already created by migration 007; repeated so 008 is self-contained and so the
-- dependency is explicit. Without it, every deleted row costs a sequential scan
-- over the whole corpus.
CREATE INDEX IF NOT EXISTS knowledge_base_document_id_idx
  ON knowledge_base ((metadata->>'document_id'));

-- ── Cascade function ────────────────────────────────────────────────────────
-- SECURITY DEFINER: knowledge_base is FORCE ROW LEVEL SECURITY (migration 001),
-- so the cascade is subject to policies even for the table owner. Running as the
-- function owner means a role that may delete a registry row cannot end up
-- deleting the document while silently failing to retract its chunks. The
-- permissive DELETE policy from migration 007 is what lets the delete through.
--
-- search_path is pinned because a SECURITY DEFINER function inherits the caller's
-- search_path otherwise, which is a privilege-escalation vector (the caller could
-- shadow `knowledge_base` with a table of their own).
CREATE OR REPLACE FUNCTION delete_knowledge_chunks_for_document()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM knowledge_base
   WHERE metadata->>'document_id' = OLD.id::text;

  -- The return value of an AFTER ... FOR EACH ROW trigger is ignored.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION delete_knowledge_chunks_for_document() IS
  'Retracts every knowledge_base chunk tagged with the deleted document''s id (migration 008).';

-- ── Trigger ─────────────────────────────────────────────────────────────────
-- AFTER, not BEFORE: the chunks are only retracted once the registry row is
-- actually gone, so a constraint or a later BEFORE trigger aborting the delete
-- cannot leave the corpus trimmed for a document that still exists.
--
-- FOR EACH ROW is one indexed delete per document. A bulk purge of N documents
-- therefore issues N statements; if that ever becomes hot, the row-level form can
-- be replaced by a statement-level trigger with REFERENCING OLD TABLE joined
-- against knowledge_base in a single delete.
--
-- DROP + CREATE rather than CREATE OR REPLACE TRIGGER: the latter needs
-- PostgreSQL 14+, and this keeps the migration re-runnable on older instances.
DROP TRIGGER IF EXISTS trg_ingested_documents_cascade_chunks ON ingested_documents;
CREATE TRIGGER trg_ingested_documents_cascade_chunks
  AFTER DELETE ON ingested_documents
  FOR EACH ROW
  EXECUTE FUNCTION delete_knowledge_chunks_for_document();

-- ── Row-Level Security for the paths this migration opens up ────────────────
-- Migration 007 gave ingested_documents a SELECT and an INSERT policy only. RLS
-- is ENABLE (not FORCE) there, so the table owner is unaffected, but any other
-- role — the least-privileged application role this deployment should be moving
-- towards — currently cannot delete a document at all, which makes the trigger
-- above unreachable for it. Same shape as the knowledge_base write policies added
-- in 007: permissive at the DB level, with RBAC enforced in the application
-- before any write is issued.
DROP POLICY IF EXISTS rls_ingested_documents_delete ON ingested_documents;
CREATE POLICY rls_ingested_documents_delete ON ingested_documents
  FOR DELETE
  USING (true);

-- UPDATE is needed by scripts/reconcile_documents.ts, which locks the registry row
-- (SELECT ... FOR UPDATE, which Postgres checks against UPDATE policies) and then
-- writes back chunk_count and status.
DROP POLICY IF EXISTS rls_ingested_documents_update ON ingested_documents;
CREATE POLICY rls_ingested_documents_update ON ingested_documents
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

INSERT INTO schema_migrations (version) VALUES ('008_document_deletion_trigger')
  ON CONFLICT (version) DO NOTHING;
