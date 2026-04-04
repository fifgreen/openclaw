import type Redis from "ioredis";
import { z } from "zod";
import { getRedisClient, type RedisConnectionOptions } from "./index.js";
import {
  buildRedisKey,
  getKeySchema,
  getKeyTtlMs,
  MemDirValueSchema,
  MEMDIR_KEY_REGISTRY,
  type MemDirKey,
  type MemDirKeyName,
  type MemDirValue,
} from "./keys.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemDirOptions {
  /** Redis connection options (url string). Uses shared client if omitted. */
  connection?: RedisConnectionOptions;
  /** Override the shared Redis client directly (useful in tests). */
  client?: Redis;
  /** Bounded timeout for reads in ms (default: 5000). */
  timeoutMs?: number;
}

type InferKeyValue<K extends MemDirKeyName> = z.infer<(typeof MEMDIR_KEY_REGISTRY)[K]["schema"]>;

export interface MemDir {
  /**
   * Read a value from MemDir.
   * Returns null if: key missing, TTL expired, or read times out.
   * Never blocks longer than `timeoutMs`.
   */
  get<K extends MemDirKeyName>(
    descriptor: MemDirKey & { key: K },
  ): Promise<MemDirValue<InferKeyValue<K>> | null>;

  /**
   * Write a value to MemDir with auto `updatedAt` timestamp.
   * TTL defaults to the key registry value; pass `ttlMs` to override.
   */
  set<K extends MemDirKeyName>(
    descriptor: MemDirKey & { key: K },
    value: InferKeyValue<K>,
    opts?: { ttlMs?: number | null; source?: string },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;

export function createMemDir(opts: MemDirOptions = {}): MemDir {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const redis: Redis = opts.client ?? getRedisClient(opts.connection);

  async function get<K extends MemDirKeyName>(
    descriptor: MemDirKey & { key: K },
  ): Promise<MemDirValue<InferKeyValue<K>> | null> {
    const redisKey = buildRedisKey(descriptor);
    const schema = getKeySchema(descriptor.key);
    const registryTtlMs = getKeyTtlMs(descriptor.key);

    let raw: string | null;
    try {
      raw = await Promise.race([
        redis.get(redisKey),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
    } catch {
      // Connection error → treat as missing (same path as timeout)
      return null;
    }

    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const wrapperSchema = MemDirValueSchema(schema);
    const result = wrapperSchema.safeParse(parsed);
    if (!result.success) return null;

    const entry = result.data as MemDirValue<InferKeyValue<K>>;

    // Freshness check: if TTL set and value is stale, treat as missing
    // Use explicit ttlMs from entry if present, otherwise fall back to registry TTL
    // null means "never expire", so only apply freshness check if we have a numeric TTL
    const effectiveTtl = entry.ttlMs !== undefined ? entry.ttlMs : registryTtlMs;
    if (effectiveTtl !== null && Date.now() - entry.updatedAt > effectiveTtl) {
      return null;
    }

    return entry;
  }

  async function set<K extends MemDirKeyName>(
    descriptor: MemDirKey & { key: K },
    value: InferKeyValue<K>,
    opts: { ttlMs?: number | null; source?: string } = {},
  ): Promise<void> {
    const redisKey = buildRedisKey(descriptor);
    const registryTtlMs = getKeyTtlMs(descriptor.key);
    const ttlMs = opts.ttlMs !== undefined ? opts.ttlMs : registryTtlMs;

    const entry: MemDirValue<InferKeyValue<K>> = {
      value,
      updatedAt: Date.now(),
      ttlMs,
      source: opts.source ?? "unknown",
    };

    const serialized = JSON.stringify(entry);
    await redis.set(redisKey, serialized);
  }

  return { get, set };
}
