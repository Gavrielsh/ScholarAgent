import {
  deleteSessionValue,
  getSessionValue,
  setSessionValue,
} from "@/lib/redis/jsonSession";

export type AdminSessionMode =
  | "awaiting_menu_choice"
  | "awaiting_user_name"
  | "AWAITING_ADD_USER_DETAILS"
  | "AWAITING_DELETE_USER_DETAILS";

export interface AdminSession {
  mode: AdminSessionMode;
  updatedAt: number;
}

const ADMIN_SESSION_MODES = new Set<AdminSessionMode>([
  "awaiting_menu_choice",
  "awaiting_user_name",
  "AWAITING_ADD_USER_DETAILS",
  "AWAITING_DELETE_USER_DETAILS",
]);

/**
 * L0/L1 menu and prompt state (chat-history + user management).
 *
 * Backed by Redis (same rationale as lib/chat/adminAnalyticsSession.ts): the
 * BullMQ worker runs with concurrency > 1 and no per-sender lock, so a process-
 * local Map desyncs when two messages from the same admin overlap or land on
 * different instances.
 *
 * Key prefix is historical (`l0session`) so in-flight sessions survive the
 * L0-only → L0/L1 rename.
 */
const KEY_PREFIX = "admin:l0session:";
const TTL_SECONDS = 60 * 60;

function sessionKey(adminPhone: string): string {
  return `${KEY_PREFIX}${adminPhone}`;
}

function isAdminSessionMode(value: unknown): value is AdminSessionMode {
  return typeof value === "string" && ADMIN_SESSION_MODES.has(value as AdminSessionMode);
}

export function isUserManagementSessionMode(mode: AdminSessionMode): boolean {
  return mode === "AWAITING_ADD_USER_DETAILS" || mode === "AWAITING_DELETE_USER_DETAILS";
}

export async function getAdminSession(adminPhone: string): Promise<AdminSession | null> {
  const raw = await getSessionValue(sessionKey(adminPhone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; updatedAt?: unknown };
    if (!isAdminSessionMode(parsed.mode)) {
      return null;
    }
    return {
      mode: parsed.mode,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export async function setAdminSession(
  adminPhone: string,
  mode: AdminSessionMode
): Promise<void> {
  const session: AdminSession = { mode, updatedAt: Date.now() };
  await setSessionValue(sessionKey(adminPhone), JSON.stringify(session), TTL_SECONDS);
}

export async function clearAdminSession(adminPhone: string): Promise<void> {
  await deleteSessionValue(sessionKey(adminPhone));
}
