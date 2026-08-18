import { Redis, type RedisOptions } from "ioredis";

export type RedisClient = Redis;

export function createRedisClient(
  redisUrl: string,
  options: RedisOptions = {},
): RedisClient {
  const clientOptions: RedisOptions = {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    ...options,
  };
  return new Redis(redisUrl, clientOptions as never);
}

export async function closeRedisClient(client: RedisClient): Promise<void> {
  if (client.status === "end") return;
  if (client.status === "wait") {
    client.disconnect();
    return;
  }
  await client.quit();
}
