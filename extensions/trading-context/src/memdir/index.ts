import Redis from "ioredis";

let _client: Redis | null = null;

export interface RedisConnectionOptions {
  url?: string;
}

/** Returns a shared Redis client, creating on first call. */
export function getRedisClient(opts: RedisConnectionOptions = {}): Redis {
  if (_client) return _client;
  const url = opts.url ?? "redis://localhost:6379";
  _client = new Redis(url, {
    lazyConnect: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
  });
  return _client;
}

/** Replaces the active client (used in tests to inject a mock). */
export function setRedisClient(client: Redis): void {
  _client = client;
}

/** Closes the shared client (call on process exit). */
export async function closeRedisClient(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}
