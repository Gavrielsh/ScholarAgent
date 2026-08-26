import { getRedisClient } from "@/lib/core/redis/client";

const KEY_PREFIX = "wa:idempotency:";
const TTL_SECONDS = 30 * 60;

function idempotencyKey(messageId: string): string {
  return `${KEY_PREFIX}${messageId}`;
}

/**
 * Atomically claims a WhatsApp message id for processing (SET NX + TTL).
 * Returns true when this instance won the claim; false if already claimed or processed.
 */
export async function tryClaimWhatsAppMessage(messageId: string): Promise<boolean> {
  const result = await getRedisClient().set(
    idempotencyKey(messageId),
    "1",
    "EX",
    TTL_SECONDS,
    "NX"
  );
  return result === "OK";
}

/** Releases a claim so BullMQ retries or a failed enqueue can be retried by Meta. */
export async function releaseWhatsAppMessageClaim(messageId: string): Promise<void> {
  await getRedisClient().del(idempotencyKey(messageId));
}
