import { withRlsTransaction } from "@/lib/core/db";
import { isAdminRole } from "@/lib/security/auth/roles";
import type { PermissionLevel } from "@/lib/security/auth/types";
import { logError } from "@/lib/core/logger";

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

/** Thrown when an admin-only capability (specific-user lookup) is reached by a
 * non-admin requesterPermissionLevel. Defense-in-depth: the orchestrator already
 * gates these flows to L0, but this repository layer re-validates independently so
 * a future refactor bug elsewhere can never leak another user's chat history. */
export class ForbiddenAdminActionError extends Error {
  constructor(action: string, requesterPermissionLevel: PermissionLevel) {
    super(`Admin-only action "${action}" attempted by permission level ${requesterPermissionLevel}`);
    this.name = "ForbiddenAdminActionError";
  }
}

const REPORT_TIMEZONE = process.env.CHAT_REPORT_TIMEZONE ?? "Asia/Jerusalem";

function todayStartParam(): string {
  return REPORT_TIMEZONE;
}

/**
 * Report scope is derived exclusively from the trusted, DB-resolved requester
 * permission level — never from an externally-supplied level list. L0 (Admin) gets
 * a full bypass across every tier; everyone else keeps the historical L2/L3 scope.
 */
function resolveReportLevels(requesterPermissionLevel: PermissionLevel): PermissionLevel[] {
  return isAdminRole(requesterPermissionLevel) ? [0, 1, 2, 3] : [2, 3];
}

/**
 * All chat_history rows in scope for the requester since local midnight (report
 * timezone). Scope is computed server-side from requesterPermissionLevel; the SQL
 * `WHERE u.permission_level = ANY($1)` clause is an app-level guarantee on top of
 * the `rls_chat_history_select` RLS policy (set via withRlsTransaction below), so
 * unauthorized rows are excluded even if one of the two layers is misconfigured.
 */
async function fetchTodayStaffChatHistories(
  requesterPermissionLevel: PermissionLevel
): Promise<StaffChatRow[]> {
  const levels = resolveReportLevels(requesterPermissionLevel);

  try {
    const result = await withRlsTransaction(requesterPermissionLevel, (client) =>
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
    logError("admin_history_fetch_staff_failed", err, { requesterPermissionLevel, levels });
    throw err;
  }
}

export async function loadTodayStaffContext(
  requesterPermissionLevel: PermissionLevel
): Promise<{ rows: StaffChatRow[]; formatted: string }> {
  const rows = await fetchTodayStaffChatHistories(requesterPermissionLevel);
  return {
    rows,
    formatted: formatStaffRowsForLlm(rows, requesterPermissionLevel),
  };
}

/**
 * Directory search used by the L0 "Specific User" report flow. Admin-only: it can
 * surface any registered user (including L0/L1), so it must never be reachable by
 * a non-admin requester.
 */
export async function findUsersByDisplayName(
  name: string,
  requesterPermissionLevel: PermissionLevel
): Promise<UserDirectoryEntry[]> {
  if (!isAdminRole(requesterPermissionLevel)) {
    throw new ForbiddenAdminActionError("findUsersByDisplayName", requesterPermissionLevel);
  }

  const trimmed = name.trim();
  if (!trimmed) return [];

  try {
    const result = await withRlsTransaction(requesterPermissionLevel, (client) =>
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
    logError("admin_history_find_user_failed", err, { name: trimmed, requesterPermissionLevel });
    throw err;
  }
}

/**
 * Full-day chat history for one arbitrary phone number. Admin-only: unlike the
 * daily summary (scoped by permission level), this can target any single user, so
 * it must never be reachable by a non-admin requester.
 */
export async function fetchTodayChatHistoryForPhone(
  phoneNumber: string,
  requesterPermissionLevel: PermissionLevel
): Promise<StaffChatRow[]> {
  if (!isAdminRole(requesterPermissionLevel)) {
    throw new ForbiddenAdminActionError("fetchTodayChatHistoryForPhone", requesterPermissionLevel);
  }

  try {
    const result = await withRlsTransaction(requesterPermissionLevel, (client) =>
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
    logError("admin_history_fetch_user_day_failed", err, { phoneNumber, requesterPermissionLevel });
    throw err;
  }
}

function formatStaffRowsForLlm(
  rows: StaffChatRow[],
  requesterPermissionLevel: PermissionLevel
): string {
  if (rows.length === 0) {
    // Empty result sets are formatted, human-readable Hebrew — never thrown as errors.
    return isAdminRole(requesterPermissionLevel)
      ? "אין הודעות היום מאף אחד מהמשתמשים (L0 עד L3)."
      : "אין הודעות היום ממשתמשי L2 או L3.";
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
