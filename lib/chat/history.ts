/**
 * PostgreSQL-backed chat history (WhatsApp `sender_id` = E.164 phone number).
 *
 * DDL lives in `migrations/001_initial_schema.sql` (chat_history table,
 * sender indexes, and the partial unique index on message_id).
 */

import { isUniqueViolation, withSenderTransaction } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/logger";

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

/**
 * Appends turns, skipping any whose `message_id` is already stored.
 *
 * Idempotent by construction (see migration 006): a BullMQ retry replays the
 * exact same `message_id`, so the conflict clause turns what used to be a
 * duplicate row into a no-op. Returns how many rows were actually written so
 * callers can tell a fresh write from a replay.
 *
 * Deliberately returns a count rather than the whole history — the previous
 * signature re-read all 40 rows after every insert, adding a round trip to the
 * user's critical path for a value that only one caller ever used.
 */
export async function appendChatEntries(
  senderId: string,
  newEntries: ChatHistoryEntry[]
): Promise<number> {
  assertSenderId(senderId);

  if (newEntries.length === 0) {
    return 0;
  }

  try {
    return await withSenderTransaction(senderId, async (client) => {
      let inserted = 0;
      for (const entry of newEntries) {
        // ON CONFLICT must repeat the index predicate verbatim for Postgres to
        // infer the partial unique index `chat_history_message_id_key`.
        const result = await client.query(
          `INSERT INTO chat_history (sender_id, role, content, message_id, occurred_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
          [
            senderId,
            entry.role,
            entry.content,
            entry.messageId ?? null,
            entry.timestamp ? new Date(entry.timestamp) : new Date(),
          ]
        );
        inserted += result.rowCount ?? 0;
      }
      return inserted;
    });
  } catch (err) {
    // Belt and braces: ON CONFLICT above covers the inferable case, but a
    // future constraint (or a race against a concurrent writer on a different
    // index) can still surface 23505. That is a duplicate, not a failure —
    // swallow it so the caller does not trigger a pointless BullMQ retry.
    if (isUniqueViolation(err)) {
      logInfo("chat_history_append_duplicate", "Duplicate chat turn ignored.", { senderId });
      return 0;
    }
    logError("chat_history_append_failed", err, { senderId });
    throw err;
  }
}

export async function readChatHistory(senderId: string): Promise<ChatHistoryFile> {
  assertSenderId(senderId);

  try {
    const rows = await withSenderTransaction(senderId, (client) =>
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
