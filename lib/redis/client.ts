import Redis from "ioredis";

import { logError } from "@/lib/logger";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

let redisClient: Redis | null = null;

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  client.on("error", (err) => {
    logError("redis_client_error", err);
  });

  return client;
}

/** Shared Redis connection for idempotency keys and BullMQ. */
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
