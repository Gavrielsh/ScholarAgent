import { ADMIN_PERMISSION_LEVEL, MANAGER_PERMISSION_LEVEL } from "@/lib/security/auth/rls";
import type { PermissionLevel, UserContext } from "@/lib/security/auth/types";

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

/**
 * Whether the caller bypasses the **privacy** guardrails (identity lookups,
 * personal-data requests, negative-targeting rewrites).
 *
 * L0/L1 run legitimate cross-user analytics, so blocking those queries would
 * break the admin reporting flows by design.
 *
 * This does NOT and MUST NOT gate distress detection. Distress handoff runs for
 * every tier without exception: an L1 training manager relaying a child's
 * message is one of the likeliest paths for a crisis to reach this system, and
 * the previous `shouldSkipGuardrails` silently excluded exactly that case.
 * See `evaluateInboundSafety` in lib/security/guardrails/safetySignals.ts.
 */
export function shouldSkipPrivacyGuardrails(user: UserContext): boolean {
  return isElevatedRole(user.permissionLevel);
}
