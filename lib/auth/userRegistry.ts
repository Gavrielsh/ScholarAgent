import { query } from "@/lib/db/client";
import { PERMISSION_ROLE } from "@/lib/auth/types";
import type { PermissionLevel, UserContext } from "@/lib/auth/types";
import { logError, logInfo } from "@/lib/logger";

interface UserRow {
  id: string;
  phone_number: string;
  permission_level: PermissionLevel;
  organization_id: string | null;
}

function redactPhone(phoneNumber: string): string {
  if (phoneNumber.length <= 4) return "****";
  return `${phoneNumber.slice(0, 3)}***${phoneNumber.slice(-2)}`;
}

function toUserContext(row: UserRow): UserContext | null {
  if (!(row.permission_level in PERMISSION_ROLE)) {
    logError("user_registry_invalid_permission_level", new Error("invalid permission_level"), {
      userId: row.id,
      permissionLevel: row.permission_level,
    });
    return null;
  }

  return {
    userId: row.id,
    permissionLevel: row.permission_level,
    roleName: PERMISSION_ROLE[row.permission_level],
    organizationId: row.organization_id ?? undefined,
  };
}

// Thrown when the DB is unreachable — distinguishes infrastructure failures
// from genuine "phone not registered" cases so callers can respond differently.
export class UserRegistryDbError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "DB lookup failed");
    this.name = "UserRegistryDbError";
    if (cause instanceof Error && cause.stack) {
      this.stack = cause.stack;
    }
  }
}

// Look up a WhatsApp sender's permission level from the `users` table.
// Returns null  → phone not registered (send UNAUTHORIZED_MESSAGE).
// Throws UserRegistryDbError → DB unreachable (send a "try again" message, not "unauthorized").
export async function lookupUserByPhone(phoneNumber: string): Promise<UserContext | null> {
  let result;
  try {
    result = await query<UserRow>(
      `SELECT id, phone_number, permission_level, organization_id
         FROM users
        WHERE phone_number = $1
        LIMIT 1;`,
      [phoneNumber]
    );
  } catch (err) {
    logError("user_registry_lookup_failed", err, { phone: redactPhone(phoneNumber) });
    throw new UserRegistryDbError(err);
  }

  const row = result.rows[0];
  if (!row) {
    logInfo("user_registry_phone_not_found", "Phone is not registered.", {
      phone: redactPhone(phoneNumber),
    });
    return null;
  }

  const context = toUserContext(row);
  if (context) {
    logInfo("user_registry_resolved", "Sender mapped to a registered role.", {
      phone: redactPhone(phoneNumber),
      permissionLevel: context.permissionLevel,
      roleName: context.roleName,
    });
  }
  return context;
}

/** JWT `sub` lookup used by HTTP upload auth. Returns null when the id is unknown. */
export async function lookupUserById(userId: string): Promise<UserContext | null> {
  let result;
  try {
    result = await query<UserRow>(
      `SELECT id, phone_number, permission_level, organization_id
         FROM users
        WHERE id = $1
        LIMIT 1;`,
      [userId]
    );
  } catch (err) {
    logError("user_registry_lookup_by_id_failed", err, { userId });
    throw new UserRegistryDbError(err);
  }

  const row = result.rows[0];
  if (!row) return null;
  return toUserContext(row);
}
