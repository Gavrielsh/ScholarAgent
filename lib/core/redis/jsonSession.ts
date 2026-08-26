import { getRedisClient } from "@/lib/core/redis/client";

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
