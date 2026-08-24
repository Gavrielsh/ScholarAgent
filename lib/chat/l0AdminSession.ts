import {
  deleteSessionValue,
  getSessionValue,
  setSessionValue,
} from "@/lib/redis/jsonSession";

export type L0AdminSessionMode =
  | "awaiting_menu_choice"
  | "awaiting_user_name";

export interface L0AdminSession {
  mode: L0AdminSessionMode;
  updatedAt: number;
}

/**
 * L0 menu / specific-user prompt state.
 *
 * Backed by Redis (same rationale as lib/chat/adminAnalyticsSession.ts): the
 * BullMQ worker runs with concurrency > 1 and no per-sender lock, so a process-
 * local Map desyncs when two messages from the same admin overlap or land on
 * different instances.
 */
const KEY_PREFIX = "admin:l0session:";
const TTL_SECONDS = 60 * 60;

function sessionKey(adminPhone: string): string {
  return `${KEY_PREFIX}${adminPhone}`;
}

export async function getL0AdminSession(adminPhone: string): Promise<L0AdminSession | null> {
  const raw = await getSessionValue(sessionKey(adminPhone));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; updatedAt?: unknown };
    if (parsed.mode !== "awaiting_menu_choice" && parsed.mode !== "awaiting_user_name") {
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

export async function setL0AdminSession(
  adminPhone: string,
  mode: L0AdminSessionMode
): Promise<void> {
  const session: L0AdminSession = { mode, updatedAt: Date.now() };
  await setSessionValue(sessionKey(adminPhone), JSON.stringify(session), TTL_SECONDS);
}

export async function clearL0AdminSession(adminPhone: string): Promise<void> {
  await deleteSessionValue(sessionKey(adminPhone));
}
