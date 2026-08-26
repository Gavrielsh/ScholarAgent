import Redis from "ioredis";

import { logError } from "@/lib/core/logger";

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

let redisClient: Redis | null = null;

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;
  // Finite retries: this client is used by the webhook claim path and admin
  // session flags. `maxRetriesPerRequest: null` is reserved for BullMQ
  // (lib/core/queue.ts) so a hung SET NX cannot block Meta's ACK window.
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  client.on("error", (err) => {
    logError("redis_client_error", err);
  });

  return client;
}

/** Shared Redis connection for idempotency keys and admin session flags. */
export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

export async function closeRedisClient(): Promise<void> {
  if (!redisClient) return;
  const client = redisClient;
  redisClient = null;
  await client.quit();
}

// ---------------------------------------------------------------------------
// WhatsApp message idempotency
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// JSON session values
// ---------------------------------------------------------------------------

export async function getSessionValue(key: string): Promise<string | null> {
  return getRedisClient().get(key);
}

export async function setSessionValue(
  key: string,
  value: string,
  ttlSeconds: number
): Promise<void> {
  await getRedisClient().set(key, value, "EX", ttlSeconds);
}

export async function deleteSessionValue(key: string): Promise<void> {
  await getRedisClient().del(key);
}

export async function expireSessionValue(key: string, ttlSeconds: number): Promise<void> {
  await getRedisClient().expire(key, ttlSeconds);
}
