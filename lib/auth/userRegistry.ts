import { query } from "@/lib/db/client";
import { PERMISSION_ROLE } from "@/lib/auth/types";
import type { PermissionLevel, UserContext } from "@/lib/auth/types";

interface UserRow {
  id: string;
  phone_number: string;
  permission_level: PermissionLevel;
  organization_id: string | null;
}

// Look up a WhatsApp sender's permission level from the `users` table.
// Returns a Guest (L4) context when the phone number is not registered —
// this is the safe default: unknown callers get the least privilege possible.
export async function lookupUserByPhone(phoneNumber: string): Promise<UserContext> {
  try {
    const result = await query<UserRow>(
      `SELECT id, phone_number, permission_level, organization_id
         FROM users
        WHERE phone_number = $1
        LIMIT 1;`,
      [phoneNumber]
    );

    const row = result.rows[0];
    if (!row) {
      return guestContext(phoneNumber);
    }

    return {
      userId: row.id,
      permissionLevel: row.permission_level,
      roleName: PERMISSION_ROLE[row.permission_level],
      organizationId: row.organization_id ?? undefined,
    };
  } catch (err) {
    // DB unreachable → fail safe to Guest rather than crash the webhook.
    // TODO: Wire structured logging so this degradation is observable.
    console.error("userRegistry: DB lookup failed, defaulting to Guest:", err);
    return guestContext(phoneNumber);
  }
}

// Synthesises a minimal Guest context for callers not found in the registry.
// The userId encodes the phone so it can still be used for audit logs.
function guestContext(phoneNumber: string): UserContext {
  return {
    userId: `phone:${phoneNumber}`,
    permissionLevel: 4,
    roleName: PERMISSION_ROLE[4],
    organizationId: undefined,
  };
}
