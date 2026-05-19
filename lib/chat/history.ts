/**
 * PostgreSQL-backed chat history (WhatsApp `sender_id` = E.164 phone number).
 *
 * ## DDL (also applied via `migrations/004_chat_history.sql`)
 *
 * ```sql
 * CREATE TABLE chat_history (
 *   id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   sender_id   TEXT NOT NULL,              -- WhatsApp phone (E.164), session key
 *   role        TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
 *   content     TEXT NOT NULL,
 *   message_id  TEXT,                       -- Meta message id (dedup / audit)
 *   occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
 * );
 *
 * CREATE INDEX chat_history_sender_occurred_idx
 *   ON chat_history (sender_id, occurred_at ASC, created_at ASC);
 *
 * CREATE INDEX chat_history_sender_created_idx
 *   ON chat_history (sender_id, created_at DESC);
 * ```
 */

import { withClient } from "@/lib/db/client";
import { logError } from "@/lib/logger";

export interface ChatHistoryEntry {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  messageId?: string;
}

export interface ChatHistoryFile {
  senderId: string;
  createdAt: string;
  updatedAt: string;
  entries: ChatHistoryEntry[];
}

const FETCH_LIMIT = Number(process.env.CHAT_HISTORY_FETCH_LIMIT ?? 40);

function assertSenderId(senderId: string): void {
  if (!senderId?.trim()) {
    throw new Error("senderId חסר עבור פעולת היסטוריית שיחה.");
  }
}

export async function appendChatEntries(
  senderId: string,
  newEntries: ChatHistoryEntry[]
): Promise<ChatHistoryFile> {
  assertSenderId(senderId);

  if (newEntries.length === 0) {
    return readChatHistory(senderId);
  }

  try {
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        for (const entry of newEntries) {
          await client.query(
            `INSERT INTO chat_history (sender_id, role, content, message_id, occurred_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              senderId,
              entry.role,
              entry.content,
              entry.messageId ?? null,
              entry.timestamp ? new Date(entry.timestamp) : new Date(),
            ]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    });
  } catch (err) {
    logError("chat_history_append_failed", err, { senderId });
    throw err;
  }

  return readChatHistory(senderId);
}

export async function readChatHistory(senderId: string): Promise<ChatHistoryFile> {
  assertSenderId(senderId);

  try {
    const rows = await withClient((client) =>
      client.query<{
        role: "user" | "assistant" | "system";
        content: string;
        message_id: string | null;
        occurred_at: Date;
        created_at: Date;
      }>(
        `SELECT role, content, message_id, occurred_at, created_at
         FROM chat_history
         WHERE sender_id = $1
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT $2`,
        [senderId, FETCH_LIMIT]
      )
    );

    const entries: ChatHistoryEntry[] = [...rows.rows].reverse().map((row) => ({
      role: row.role,
      content: row.content,
      timestamp: row.occurred_at.toISOString(),
      messageId: row.message_id ?? undefined,
    }));

    const createdAt = entries[0]?.timestamp ?? new Date().toISOString();
    const updatedAt = entries[entries.length - 1]?.timestamp ?? createdAt;

    return { senderId, createdAt, updatedAt, entries };
  } catch (err) {
    logError("chat_history_read_failed", err, { senderId });
    throw err;
  }
}
