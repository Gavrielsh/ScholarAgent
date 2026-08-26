import { isUniqueViolation, query } from "@/lib/core/db/client";
import { PERMISSION_ROLE } from "@/lib/security/auth/types";
import type { PermissionLevel, UserContext } from "@/lib/security/auth/types";
import { logError, logInfo } from "@/lib/core/logger";

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

export function normalizePhoneNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  let normalized = digits;
  if (normalized.startsWith("00")) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith("0") && normalized.length >= 9 && normalized.length <= 11) {
    normalized = `972${normalized.slice(1)}`;
  }

  if (normalized.length < 8 || normalized.length > 15) return null;
  return normalized;
}

function asPermissionLevel(value: number): PermissionLevel | null {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  return null;
}

export interface ManagedUserRecord {
  phone_number: string;
  display_name: string;
  permission_level: PermissionLevel;
}

export async function insertAdminManagedUser(
  phone: string,
  name: string,
  level: number
): Promise<boolean> {
  const normalized = normalizePhoneNumber(phone);
  const permissionLevel = asPermissionLevel(level);
  const displayName = name.trim();
  if (!normalized || permissionLevel === null || !displayName) return false;

  try {
    const result = await query(
      `INSERT INTO users (phone_number, display_name, permission_level, organization_id)
       VALUES ($1, $2, $3, NULL)`,
      [normalized, displayName, permissionLevel]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    if (isUniqueViolation(err)) {
      logInfo("user_registry_insert_duplicate", "Phone already registered.", {
        phone: redactPhone(normalized),
      });
      return false;
    }
    logError("user_registry_insert_failed", err, { phone: redactPhone(normalized) });
    throw new UserRegistryDbError(err);
  }
}

export async function deleteAdminManagedUser(phone: string): Promise<boolean> {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return false;

  try {
    const result = await query(`DELETE FROM users WHERE phone_number = $1`, [normalized]);
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logError("user_registry_delete_failed", err, { phone: redactPhone(normalized) });
    throw new UserRegistryDbError(err);
  }
}

export async function getAllManagedUsers(): Promise<ManagedUserRecord[]> {
  try {
    const result = await query<{
      phone_number: string;
      display_name: string | null;
      permission_level: number;
    }>(
      `SELECT phone_number, display_name, permission_level
         FROM users
        ORDER BY permission_level ASC, display_name ASC NULLS LAST, phone_number ASC`
    );
    return result.rows.flatMap((row) => {
      const permissionLevel = asPermissionLevel(row.permission_level);
      if (permissionLevel === null) return [];
      return [
        {
          phone_number: row.phone_number,
          display_name: row.display_name ?? "",
          permission_level: permissionLevel,
        },
      ];
    });
  } catch (err) {
    logError("user_registry_list_failed", err);
    throw new UserRegistryDbError(err);
  }
}

export async function getUserByPhone(
  phone: string
): Promise<{ permission_level: PermissionLevel } | null> {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return null;

  try {
    const result = await query<{ permission_level: number }>(
      `SELECT permission_level FROM users WHERE phone_number = $1 LIMIT 1`,
      [normalized]
    );
    const row = result.rows[0];
    if (!row) return null;
    const permissionLevel = asPermissionLevel(row.permission_level);
    if (permissionLevel === null) return null;
    return { permission_level: permissionLevel };
  } catch (err) {
    logError("user_registry_get_by_phone_failed", err, { phone: redactPhone(normalized) });
    throw new UserRegistryDbError(err);
  }
}

export const adminAddUser = insertAdminManagedUser;
export const adminDeleteUser = deleteAdminManagedUser;
