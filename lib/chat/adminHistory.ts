import { withClient } from "@/lib/db/client";
import type { PermissionLevel } from "@/lib/auth/types";
import { logError } from "@/lib/logger";

export interface StaffChatRow {
  phoneNumber: string;
  displayName: string | null;
  permissionLevel: PermissionLevel;
  role: "user" | "assistant" | "system";
  content: string;
  occurredAt: string;
}

export interface UserDirectoryEntry {
  userId: string;
  phoneNumber: string;
  displayName: string | null;
  permissionLevel: PermissionLevel;
}

const REPORT_TIMEZONE = process.env.CHAT_REPORT_TIMEZONE ?? "Asia/Jerusalem";

function todayStartParam(): string {
  return REPORT_TIMEZONE;
}

/**
 * All chat_history rows for L2/L3 users since local midnight (report timezone).
 */
export async function fetchTodayStaffChatHistories(
  levels: PermissionLevel[] = [2, 3]
): Promise<StaffChatRow[]> {
  try {
    const result = await withClient((client) =>
      client.query<{
        phone_number: string;
        display_name: string | null;
        permission_level: PermissionLevel;
        role: "user" | "assistant" | "system";
        content: string;
        occurred_at: Date;
      }>(
        `SELECT u.phone_number, u.display_name, u.permission_level,
                ch.role, ch.content, ch.occurred_at
           FROM chat_history ch
           INNER JOIN users u ON u.phone_number = ch.sender_id
          WHERE u.permission_level = ANY($1::int[])
            AND ch.occurred_at >= date_trunc('day', timezone($2, now()))
          ORDER BY u.display_name NULLS LAST, u.phone_number, ch.occurred_at ASC`,
        [levels, todayStartParam()]
      )
    );

    return result.rows.map((row) => ({
      phoneNumber: row.phone_number,
      displayName: row.display_name,
      permissionLevel: row.permission_level,
      role: row.role,
      content: row.content,
      occurredAt: row.occurred_at.toISOString(),
    }));
  } catch (err) {
    logError("admin_history_fetch_staff_failed", err, { levels });
    throw err;
  }
}

export async function findUsersByDisplayName(name: string): Promise<UserDirectoryEntry[]> {
  const trimmed = name.trim();
  if (!trimmed) return [];

  try {
    const result = await withClient((client) =>
      client.query<{
        id: string;
        phone_number: string;
        display_name: string | null;
        permission_level: PermissionLevel;
      }>(
        `SELECT id, phone_number, display_name, permission_level
           FROM users
          WHERE display_name ILIKE $1
          ORDER BY display_name ASC
          LIMIT 10`,
        [`%${trimmed}%`]
      )
    );

    return result.rows.map((row) => ({
      userId: row.id,
      phoneNumber: row.phone_number,
      displayName: row.display_name,
      permissionLevel: row.permission_level,
    }));
  } catch (err) {
    logError("admin_history_find_user_failed", err, { name: trimmed });
    throw err;
  }
}

export async function fetchTodayChatHistoryForPhone(phoneNumber: string): Promise<StaffChatRow[]> {
  try {
    const result = await withClient((client) =>
      client.query<{
        phone_number: string;
        display_name: string | null;
        permission_level: PermissionLevel;
        role: "user" | "assistant" | "system";
        content: string;
        occurred_at: Date;
      }>(
        `SELECT u.phone_number, u.display_name, u.permission_level,
                ch.role, ch.content, ch.occurred_at
           FROM chat_history ch
           INNER JOIN users u ON u.phone_number = ch.sender_id
          WHERE ch.sender_id = $1
            AND ch.occurred_at >= date_trunc('day', timezone($2, now()))
          ORDER BY ch.occurred_at ASC`,
        [phoneNumber, todayStartParam()]
      )
    );

    return result.rows.map((row) => ({
      phoneNumber: row.phone_number,
      displayName: row.display_name,
      permissionLevel: row.permission_level,
      role: row.role,
      content: row.content,
      occurredAt: row.occurred_at.toISOString(),
    }));
  } catch (err) {
    logError("admin_history_fetch_user_day_failed", err, { phoneNumber });
    throw err;
  }
}

export function formatStaffRowsForLlm(rows: StaffChatRow[]): string {
  if (rows.length === 0) {
    return "אין הודעות היום ממשתמשי L2 או L3.";
  }

  const byUser = new Map<string, StaffChatRow[]>();
  for (const row of rows) {
    const key = row.displayName ?? row.phoneNumber;
    const bucket = byUser.get(key) ?? [];
    bucket.push(row);
    byUser.set(key, bucket);
  }

  const sections: string[] = [];
  for (const [userLabel, messages] of byUser.entries()) {
    const lines = messages.map(
      (m) => `[${m.role}] ${m.content} (${m.occurredAt})`
    );
    sections.push(`=== ${userLabel} (L${messages[0].permissionLevel}) ===\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

export function formatStaffRowsAsDirectReport(rows: StaffChatRow[], userLabel: string): string {
  if (rows.length === 0) {
    return `אין הודעות היום עבור ${userLabel}.`;
  }

  return rows
    .map((row) => {
      const time = new Date(row.occurredAt).toLocaleString("he-IL", {
        timeZone: REPORT_TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
      });
      const speaker = row.role === "user" ? "משתמש" : "בוט";
      return `[${time}] ${speaker}: ${row.content}`;
    })
    .join("\n");
}
