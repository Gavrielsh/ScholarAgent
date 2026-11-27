-- =============================================================================
-- 004_parent_child_chunks.sql — parent/child ("small-to-big") chunking
-- =============================================================================
--
-- Retrieval searches small child chunks (precise embeddings, ~350-450 chars) and
-- returns the larger parent chunk (~1200-1500 chars) for generation, so the
-- model reads a coherent passage rather than a sentence fragment.
--
-- ## Why this does not weaken RLS
--
-- A parent and its children are written with the SAME classification_level, in
-- the same transaction, by lib/core/db.ts::insertDocumentWithChunks. The
-- existing SELECT policy on knowledge_base
--
--     classification_level >= current_setting('app.user_permission_level')::int
--
-- therefore applies to the parent row exactly as it applies to the child, and
-- parent resolution runs inside the SAME RLS transaction as the child search
-- (never via withServiceClient). A caller who cannot see the child cannot see
-- the parent, and vice versa. No new policy is required and none is added: this
-- migration alters an existing table that already has ENABLE + FORCE ROW LEVEL
-- SECURITY from 001, rather than introducing a new sensitive table.
--
-- Backward compatibility: every pre-existing row keeps parent_id = NULL and
-- is_parent = false, so it stays searchable as a child and resolves to its own
-- text when no parent is linked.

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
-- Self-referencing FK. ON DELETE CASCADE means deleting a parent removes its
-- children, which matches how document deletion already fans out through
-- delete_knowledge_chunks_for_document().
--
-- `embedding` is left nullable (as declared in 001) on purpose: parent rows are
-- never searched directly and carry embedding = NULL, so the project pays no
-- embedding cost for them.

ALTER TABLE knowledge_base
  ADD COLUMN IF NOT EXISTS parent_id UUID
    REFERENCES knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE knowledge_base
  ADD COLUMN IF NOT EXISTS is_parent BOOLEAN NOT NULL DEFAULT false;

-- -----------------------------------------------------------------------------
-- 2. Index
-- -----------------------------------------------------------------------------
-- Partial: only child rows carry a parent_id, and the retrieval path looks up
-- parents by the children's parent_id. Indexing the NULLs would be dead weight.

CREATE INDEX IF NOT EXISTS knowledge_base_parent_id_idx
  ON knowledge_base (parent_id)
  WHERE parent_id IS NOT NULL;

-- Keeps the `is_parent = false` predicate on both retrieval legs off a seq scan
-- once the corpus holds a parent row per ~3-4 children.
CREATE INDEX IF NOT EXISTS knowledge_base_is_parent_idx
  ON knowledge_base (is_parent)
  WHERE is_parent = false;

-- -----------------------------------------------------------------------------
-- 3. Privileges
-- -----------------------------------------------------------------------------
-- Re-asserted per the rule in CLAUDE.md: 001's GRANT and ALTER DEFAULT
-- PRIVILEGES only cover objects created by the role that ran them. Column
-- additions inherit the table's existing grants, so this is belt-and-braces —
-- but a migration applied by a different role than 001 would otherwise leave
-- the app role without access, and that failure is silent until a query runs.

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_base TO scholaragent_app;

-- -----------------------------------------------------------------------------
-- 4. Self-check
-- -----------------------------------------------------------------------------
-- Same contract as 001 §10: the database must not be stamped with this migration
-- while the guarantee the comment above depends on is absent. Fails the whole
-- transaction (and the stamp) if RLS is not still forced on knowledge_base, or
-- if the app role has regained a privilege that bypasses policies.

DO $$
DECLARE
  bad_role text;
BEGIN
  SELECT rolname INTO bad_role
    FROM pg_roles
   WHERE rolname = 'scholaragent_app'
     AND (rolsuper OR rolbypassrls);

  IF bad_role IS NOT NULL THEN
    RAISE EXCEPTION
      'scholaragent_app holds SUPERUSER or BYPASSRLS; parent resolution would bypass RLS.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'knowledge_base'
       AND c.relrowsecurity
       AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION
      'FORCE ROW LEVEL SECURITY is not active on knowledge_base; refusing to add parent/child columns.';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 5. Stamp
-- -----------------------------------------------------------------------------
-- run.ts does not record a version after applying a file; each migration stamps
-- itself, as 001 does. Without this the file re-applies on every
-- `npm run migrate`.

INSERT INTO schema_migrations (version) VALUES ('004_parent_child_chunks')
  ON CONFLICT (version) DO NOTHING;
