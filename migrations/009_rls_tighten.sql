-- Migration 009: close RLS "unset GUC = open" holes and tighten write policies.
--
-- chat_history SELECT previously allowed any session that never set
-- app.user_permission_level (plain withClient). Own-history now requires
-- app.sender_id. Admin reports still use app.user_permission_level.
--
-- ingested_documents gets FORCE RLS (owner no longer bypasses) and the same
-- classification SELECT rule without the IS NULL branch.
--
-- knowledge_base / ingested_documents writes require L0 or L1. The cascade
-- trigger from migration 008 sets the GUC before deleting chunks.

-- ── chat_history ────────────────────────────────────────────────────────────
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

-- ── ingested_documents ──────────────────────────────────────────────────────
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

-- ── knowledge_base writes ───────────────────────────────────────────────────
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

-- Cascade trigger must set the GUC: knowledge_base is FORCE RLS, so the
-- SECURITY DEFINER function is still subject to the DELETE policy above.
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
  RETURN NULL;
END;
$$;

INSERT INTO schema_migrations (version) VALUES ('009_rls_tighten')
  ON CONFLICT (version) DO NOTHING;
