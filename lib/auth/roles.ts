import { ADMIN_PERMISSION_LEVEL, MANAGER_PERMISSION_LEVEL } from "@/lib/auth/rls";
import type { PermissionLevel, UserContext } from "@/lib/auth/types";

/** L0 Admin — full access, including every user's chat history. */
export function isAdminRole(level: PermissionLevel): boolean {
  return level === ADMIN_PERMISSION_LEVEL;
}

/** L1 Manager — staff-scoped operational access. */
export function isManagerRole(level: PermissionLevel): boolean {
  return level === MANAGER_PERMISSION_LEVEL;
}

/** L0 Admin or L1 Manager — elevated operational access. */
export function isElevatedRole(level: PermissionLevel): boolean {
  return isAdminRole(level) || isManagerRole(level);
}

export function shouldSkipGuardrails(user: UserContext): boolean {
  return isElevatedRole(user.permissionLevel);
}

export function roleLevelLabel(level: PermissionLevel): string {
  return `L${level}`;
}
