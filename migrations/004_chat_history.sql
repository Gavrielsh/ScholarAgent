-- Migration 004: persistent WhatsApp chat history (replaces ephemeral filesystem storage)

CREATE TABLE IF NOT EXISTS chat_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  message_id  TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_history_sender_occurred_idx
  ON chat_history (sender_id, occurred_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS chat_history_sender_created_idx
  ON chat_history (sender_id, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('004_chat_history')
  ON CONFLICT (version) DO NOTHING;
