import {
  deleteSessionValue,
  expireSessionValue,
  getSessionValue,
  setSessionValue,
} from "@/lib/core/redis";

/**
 * ADMIN_ANALYTICS_MODE session flag for L0 admins who just received a chat-history
 * report and may now ask free-text follow-up questions about it.
 *
 * Backed by Redis (same store as lib/domain/chat/session/adminSession.ts) because:
 *  - it must survive across serverless/worker instances and restarts, and
 *  - the BullMQ worker runs with concurrency > 1 and no per-sender lock
 *    (lib/domain/whatsapp/workers/whatsappIncomingWorker.ts), so two rapid messages from the
 *    same admin can be processed concurrently. Every operation below is a single
 *    atomic Redis command (SET/GET/EXPIRE/DEL) - there is no read-modify-write of
 *    the stored value itself, so concurrent calls can never corrupt the flag.
 */

const KEY_PREFIX = "admin:analytics:";
/** Inactivity window: state expires 5 minutes after the last analytics turn. */
const TTL_SECONDS = 5 * 60;

function sessionKey(adminPhone: string): string {
  return `${KEY_PREFIX}${adminPhone}`;
}

/** Atomically enters ADMIN_ANALYTICS_MODE via a single SET...EX. */
export async function enterAdminAnalyticsMode(adminPhone: string): Promise<void> {
  await setSessionValue(sessionKey(adminPhone), "1", TTL_SECONDS);
}

/**
 * Checks whether the admin is currently in ADMIN_ANALYTICS_MODE and, if so, slides
 * the inactivity window forward. The GET and EXPIRE are two separate commands, but
 * since the value itself is immutable ("1"), the only possible race is the TTL
 * being refreshed a moment earlier/later than another concurrent call would - never
 * a torn or corrupted read.
 */
export async function isInAdminAnalyticsMode(adminPhone: string): Promise<boolean> {
  const key = sessionKey(adminPhone);
  const value = await getSessionValue(key);
  if (value === null) return false;

  await expireSessionValue(key, TTL_SECONDS);
  return true;
}

/** Explicit exit (cancel/exit command, or an off-topic query per the LLM classifier). */
export async function exitAdminAnalyticsMode(adminPhone: string): Promise<void> {
  await deleteSessionValue(sessionKey(adminPhone));
}
