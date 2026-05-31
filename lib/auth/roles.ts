import type { PermissionLevel, UserContext } from "@/lib/auth/types";

/** L0 Admin or L1 Manager — elevated operational access. */
export function isElevatedRole(level: PermissionLevel): boolean {
  return level === 0 || level === 1;
}

export function shouldSkipGuardrails(user: UserContext): boolean {
  return isElevatedRole(user.permissionLevel);
}

export function roleLevelLabel(level: PermissionLevel): string {
  return `L${level}`;
}
