-- Migration 005: Row-Level Security on chat_history
--
-- Prior to this migration, admin chat-history reports were scoped only at the
-- application layer (a hardcoded permission_level filter in lib/chat/adminHistory.ts).
-- This adds a DB-level SELECT policy as defense-in-depth, mirroring the existing
-- knowledge_base RLS pattern (migration 001):
--   - L0 (Admin) sessions get a full SELECT bypass across every tier.
--   - Sessions that explicitly opt in (via withRlsTransaction, setting
--     app.user_permission_level) but are NOT L0 only see L2/L3 senders — today's
--     default staff report scope — resolved via a join back to users.permission_level.
--   - Sessions that never set app.user_permission_level (plain withClient calls,
--     e.g. per-user chat history persistence/read for multi-turn context) are left
--     untouched: this policy is additive on top of existing app-level checks, not a
--     replacement, so it must never break message persistence or a user's own
--     conversational context.
--
-- Without this last clause, every plain INSERT/SELECT against chat_history (which
-- never sets the session var) would otherwise be silently restricted to L2/L3
-- senders only once RLS is enabled — breaking chat persistence for L0/L1 users.

ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;

-- Allow bypass for superuser / migration scripts, matching knowledge_base.
ALTER TABLE chat_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_chat_history_select ON chat_history;
CREATE POLICY rls_chat_history_select ON chat_history
  FOR SELECT
  USING (
    current_setting('app.user_permission_level', true) IS NULL
    OR current_setting('app.user_permission_level', true)::integer = 0
    OR EXISTS (
      SELECT 1 FROM users u
       WHERE u.phone_number = chat_history.sender_id
         AND u.permission_level = ANY(ARRAY[2, 3])
    )
  );

-- Message persistence (appendChatEntries) must never be blocked by RLS: it writes
-- one row at a time for the sender currently texting, independent of report scope.
DROP POLICY IF EXISTS rls_chat_history_insert ON chat_history;
CREATE POLICY rls_chat_history_insert ON chat_history
  FOR INSERT
  WITH CHECK (true);

INSERT INTO schema_migrations (version) VALUES ('005_chat_history_rls')
  ON CONFLICT (version) DO NOTHING;
