import { query } from "@/lib/db/client";
import { PERMISSION_ROLE } from "@/lib/auth/types";
import type { PermissionLevel, UserContext } from "@/lib/auth/types";

interface UserRow {
  id: string;
  phone_number: string;
  permission_level: PermissionLevel;
  organization_id: string | null;
}

// Thrown when the DB is unreachable — distinguishes infrastructure failures
// from genuine "phone not registered" cases so callers can respond differently.
export class UserRegistryDbError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : "DB lookup failed"
    );
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
    console.error("userRegistry: DB lookup failed for", phoneNumber, "—", err);
    throw new UserRegistryDbError(err);
  }

  const row = result.rows[0];
  if (!row) {
    console.log(`userRegistry: phone ${phoneNumber} not found in users table`);
    return null;
  }

  if (!(row.permission_level in PERMISSION_ROLE)) {
    console.error("userRegistry: invalid permission level for user:", {
      phoneNumber,
      permissionLevel: row.permission_level,
    });
    return null;
  }

  console.log(`userRegistry: resolved ${phoneNumber} → L${row.permission_level} (${PERMISSION_ROLE[row.permission_level]})`);
  return {
    userId: row.id,
    permissionLevel: row.permission_level,
    roleName: PERMISSION_ROLE[row.permission_level],
    organizationId: row.organization_id ?? undefined,
  };
}
