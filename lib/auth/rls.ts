import type { PermissionLevel } from "@/lib/auth/types";

export const ADMIN_PERMISSION_LEVEL: PermissionLevel = 0;
export const MANAGER_PERMISSION_LEVEL: PermissionLevel = 1;

// Schema definition for the chat_history RLS policy (applied via
// migrations/009_rls_tighten.sql). Own-history uses withSenderTransaction()
// (app.sender_id). Admin reports use withRlsTransaction() (app.user_permission_level).
export const CHAT_HISTORY_RLS_SCHEMA_SQL = `
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
`.trim();
