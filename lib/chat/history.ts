import { withClient } from "@/lib/db/client";

export interface ChatHistoryEntry {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string; // ISO 8601
  messageId?: string;
}

export interface ChatHistoryFile {
  senderId: string;
  createdAt: string;
  updatedAt: string;
  entries: ChatHistoryEntry[];
}

let tableReady = false;

async function ensureChatHistoryTable(): Promise<void> {
  if (tableReady) return;
  await withClient((client) =>
    client.query(`
      CREATE TABLE IF NOT EXISTS chat_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sender_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
        content TEXT NOT NULL,
        message_id TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chat_history_sender_occurred_idx
        ON chat_history (sender_id, occurred_at ASC, created_at ASC);
    `)
  );
  tableReady = true;
}

export async function appendChatEntries(
  senderId: string,
  newEntries: ChatHistoryEntry[]
): Promise<ChatHistoryFile> {
  if (!senderId?.trim()) {
    throw new Error("senderId חסר עבור שמירת היסטוריית שיחה.");
  }
  await ensureChatHistoryTable();

  if (newEntries.length > 0) {
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
  }
  return readChatHistory(senderId);
}

export async function readChatHistory(senderId: string): Promise<ChatHistoryFile> {
  if (!senderId?.trim()) {
    throw new Error("senderId חסר עבור קריאת היסטוריית שיחה.");
  }
  await ensureChatHistoryTable();

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
       LIMIT 20`,
      [senderId]
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
}
