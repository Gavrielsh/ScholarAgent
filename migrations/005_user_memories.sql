-- =============================================================================
-- 005_user_memories.sql — rolling per-sender conversation memory
-- =============================================================================
--
-- One row per sender holding a short Hebrew summary of their earlier turns, so
-- a long conversation keeps its thread without replaying the whole transcript
-- into every prompt. Written asynchronously by the memory-summarization worker
-- (lib/domain/chat/session/memoryWorker.ts), never on the reply path.
--
-- ## This table holds tier-sensitive rows
--
-- A summary is derived from a sender's own chat_history, so it inherits that
-- table's sensitivity: it must never be readable by another sender. Per the
-- rule in CLAUDE.md, a new migration adding a sensitive table must itself
-- ENABLE + FORCE ROW LEVEL SECURITY, write its own policies, and re-run the
-- GRANT block from 001 — `knowledge_gaps` (002) deliberately has none of that,
-- and this table is not in that category.
--
-- Scoping is by `app.sender_id`, matching the chat_history policies in 001
-- rather than the classification_level model used for knowledge_base: a memory
-- has no tier, it has an owner. `withSenderTransaction` is the only accessor,
-- and it sets exactly that GUC.

-- -----------------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------------
-- sender_id is UNIQUE: the worker upserts on it, so a sender can only ever have
-- one current summary. E.164 phone number, the same identifier
-- chat_history.sender_id carries.

CREATE TABLE IF NOT EXISTS user_memories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id  TEXT UNIQUE NOT NULL,
  summary    TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- The UNIQUE constraint already indexes sender_id, which is the only lookup
-- key, so no further index is added.

-- -----------------------------------------------------------------------------
-- 2. Row-level security
-- -----------------------------------------------------------------------------
-- FORCE as well as ENABLE: without FORCE the policies would not apply to the
-- table owner, which the least-privilege role switch in 001 §8 exists to guard.

ALTER TABLE user_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_memories FORCE ROW LEVEL SECURITY;

-- SELECT: own row when app.sender_id is set, plus full read for an L0 admin
-- session (the daily staff reports).
--
-- The `nullif(..., '')` guard is the idiom from the chat_history policies in
-- 001 and is load-bearing: `current_setting(..., true)` returns NULL when the
-- GUC was never set, and an unguarded equality against NULL would make the
-- predicate NULL rather than false. The L0 branch compares the GUC as TEXT for
-- the same reason the 001 policies do — an `::integer` cast on an empty string
-- raises, which inside a policy would turn a missing GUC into a query error
-- instead of a denial.
--
-- withSenderTransaction sets only app.sender_id, so in the worker's own
-- transactions the L0 branch evaluates to NULL and the owner branch decides.
-- That fails closed.

DROP POLICY IF EXISTS rls_user_memories_select ON user_memories;
CREATE POLICY rls_user_memories_select ON user_memories
  FOR SELECT
  USING (
    (
      nullif(current_setting('app.sender_id', true), '') IS NOT NULL
      AND sender_id = current_setting('app.sender_id', true)
    )
    OR current_setting('app.user_permission_level', true) = '0'
  );

-- INSERT / UPDATE: strictly the owning sender. An L0 admin may read a summary
-- but never write one — only the worker, acting as the sender, produces them.

DROP POLICY IF EXISTS rls_user_memories_insert ON user_memories;
CREATE POLICY rls_user_memories_insert ON user_memories
  FOR INSERT
  WITH CHECK (
    nullif(current_setting('app.sender_id', true), '') IS NOT NULL
    AND sender_id = current_setting('app.sender_id', true)
  );

-- Both USING and WITH CHECK: USING decides which existing row may be updated,
-- WITH CHECK decides what it may be updated TO. Omitting WITH CHECK would let
-- a sender reassign their own row to another sender_id.
DROP POLICY IF EXISTS rls_user_memories_update ON user_memories;
CREATE POLICY rls_user_memories_update ON user_memories
  FOR UPDATE
  USING (
    nullif(current_setting('app.sender_id', true), '') IS NOT NULL
    AND sender_id = current_setting('app.sender_id', true)
  )
  WITH CHECK (
    nullif(current_setting('app.sender_id', true), '') IS NOT NULL
    AND sender_id = current_setting('app.sender_id', true)
  );

-- -----------------------------------------------------------------------------
-- 3. Privileges
-- -----------------------------------------------------------------------------
-- RLS restricts WHICH ROWS are visible; it does not grant table access. 001's
-- ALTER DEFAULT PRIVILEGES only covers tables created by the role that ran it,
-- so a migration applied by a different role would leave the app role locked
-- out of this table entirely. Re-asserted explicitly, as 001's comment requires
-- of any migration that adds a table.
--
-- No DELETE: nothing in the system deletes a memory, and withholding it means a
-- compromised app path cannot erase a sender's summary. 001's default
-- privileges grant DELETE on every new table, so it is revoked explicitly.

GRANT USAGE ON SCHEMA public TO scholaragent_app;
GRANT SELECT, INSERT, UPDATE ON user_memories TO scholaragent_app;
REVOKE DELETE ON user_memories FROM scholaragent_app;

-- -----------------------------------------------------------------------------
-- 4. Self-check
-- -----------------------------------------------------------------------------
-- Same contract as 001 §10 and 004: the database must not be stamped with this
-- migration while the guarantees above are absent. Raising here aborts the
-- transaction, so the stamp at the bottom never lands.

DO $$
DECLARE
  bad_role   text;
  policy_cnt integer;
BEGIN
  SELECT rolname INTO bad_role
    FROM pg_roles
   WHERE rolname = 'scholaragent_app'
     AND (rolsuper OR rolbypassrls);

  IF bad_role IS NOT NULL THEN
    RAISE EXCEPTION
      'scholaragent_app holds SUPERUSER or BYPASSRLS; user_memories policies would not be enforced.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'user_memories'
       AND c.relrowsecurity
       AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'ENABLE/FORCE ROW LEVEL SECURITY is not active on user_memories.';
  END IF;

  -- A table with RLS forced but no policies denies everything, which would fail
  -- silently as "the user simply has no memory yet" rather than as an error.
  SELECT count(*) INTO policy_cnt
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'user_memories';

  IF policy_cnt < 3 THEN
    RAISE EXCEPTION
      'user_memories has % policies; expected at least 3 (select, insert, update).', policy_cnt;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 5. Stamp
-- -----------------------------------------------------------------------------
-- run.ts does not record a version after applying a file; each migration stamps
-- itself, as 001 and 004 do.

INSERT INTO schema_migrations (version) VALUES ('005_user_memories')
  ON CONFLICT (version) DO NOTHING;
