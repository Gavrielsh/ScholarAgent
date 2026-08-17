-- Migration 006: make chat_history writes idempotent under BullMQ retries.
--
-- Before this, a job that failed after persisting the inbound turn re-inserted
-- that same turn on every one of its 5 attempts, so a single user message could
-- appear 5x in history and 5x in the L0/L1 daily reports.

-- 1) Collapse pre-existing duplicates, keeping the earliest row per message_id.
--    ctid is the physical row id and is the only stable tiebreaker available
--    when two rows are otherwise byte-identical (same created_at, same content).
DELETE FROM chat_history a
      USING chat_history b
      WHERE a.message_id IS NOT NULL
        AND a.message_id = b.message_id
        AND (a.created_at, a.ctid) > (b.created_at, b.ctid);

-- 2) Partial unique index over the non-NULL values only.
--
--    A plain UNIQUE(message_id) constraint would also work — SQL treats NULLs as
--    distinct, so the many assistant rows that carry no Meta message id would not
--    collide. The partial form is preferred because it keeps those NULL rows out
--    of the index entirely: they are roughly half of the table and would
--    otherwise be dead weight on every insert.
--
--    Named with the `_key` suffix so it matches what `ALTER TABLE ... ADD
--    CONSTRAINT UNIQUE` would have produced, and so ON CONFLICT inference in
--    lib/chat/history.ts resolves against a predictable identifier.
CREATE UNIQUE INDEX IF NOT EXISTS chat_history_message_id_key
  ON chat_history (message_id)
  WHERE message_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('006_chat_history_message_id_unique')
  ON CONFLICT (version) DO NOTHING;
