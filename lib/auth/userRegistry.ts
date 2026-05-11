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
// Returns null when the phone number is not registered or has an invalid level.
export async function lookupUserByPhone(phoneNumber: string): Promise<UserContext | null> {
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
      return null;
    }

    if (!(row.permission_level in PERMISSION_ROLE)) {
      console.error("userRegistry: invalid permission level for user:", {
        phoneNumber,
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
  } catch (err) {
    console.error("userRegistry: DB lookup failed:", err);
    return null;
  }
}
