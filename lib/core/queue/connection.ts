import type { ConnectionOptions } from "bullmq";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

/** BullMQ connection options (separate pool from the idempotency ioredis client). */
export function getQueueConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;
  return {
    url,
    maxRetriesPerRequest: null,
  };
}
