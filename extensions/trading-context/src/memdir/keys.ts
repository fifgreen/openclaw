import { z } from "zod";

// ---------------------------------------------------------------------------
// Core value wrapper — every MemDir entry carries these fields.
// ---------------------------------------------------------------------------

export const MemDirValueSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.object({
    value: valueSchema,
    updatedAt: z.number(), // Unix ms
    ttlMs: z.number().nullable(),
    source: z.string(), // identifier of the writing agent/feed
  });

export type MemDirValue<T> = {
  value: T;
  updatedAt: number;
  ttlMs: number | null;
  source: string;
};

// ---------------------------------------------------------------------------
// Typed key registry — closed set of known MemDir keys with Zod schemas.
// ---------------------------------------------------------------------------

export const TradingHaltedSchema = z.object({
  halted: z.boolean(),
  reason: z.string(),
  haltedAt: z.number(),
});

export const MacroRegimeSchema = z.enum(["risk-on", "risk-off", "neutral"]);

export const FearGreedSchema = z.object({
  score: z.number(),
  classification: z.string(),
});

export const FundingRateSchema = z.object({
  rate: z.number(),
  nextFundingAt: z.number(),
});

export const SentimentSchema = z.object({
  twitter: z.number(),
  reddit: z.number(),
  tweetVolume: z.number(),
});

export const DxySchema = z.object({
  value: z.number(),
  changePct: z.number(),
});

export const Us10ySchema = z.object({
  value: z.number(),
  changeBps: z.number(),
});

// ---------------------------------------------------------------------------
// Key registry — maps logical key names to their schemas and TTL defaults.
// ---------------------------------------------------------------------------

export const MEMDIR_KEY_REGISTRY = {
  trading_halted: {
    schema: TradingHaltedSchema,
    ttlMs: null, // never expires — must be explicitly cleared
    scope: "global" as const,
  },
  macro_regime: {
    schema: MacroRegimeSchema,
    ttlMs: 4 * 60 * 60 * 1000, // 4h
    scope: "feed" as const,
  },
  fear_greed: {
    schema: FearGreedSchema,
    ttlMs: 4 * 60 * 60 * 1000, // 4h
    scope: "feed" as const,
  },
  funding_rate: {
    schema: FundingRateSchema,
    ttlMs: 8 * 60 * 60 * 1000, // 8h
    scope: "feed" as const,
  },
  sentiment: {
    schema: SentimentSchema,
    ttlMs: 4 * 60 * 60 * 1000, // 4h
    scope: "feed" as const,
  },
  dxy: {
    schema: DxySchema,
    ttlMs: 24 * 60 * 60 * 1000, // 24h
    scope: "feed" as const,
  },
  us10y: {
    schema: Us10ySchema,
    ttlMs: 24 * 60 * 60 * 1000, // 24h
    scope: "feed" as const,
  },
  consecutive_timeouts: {
    schema: z.number(),
    ttlMs: null,
    scope: "agent" as const,
  },
  last_tick_at: {
    schema: z.number(),
    ttlMs: null,
    scope: "agent" as const,
  },
} as const;

export type MemDirKeyName = keyof typeof MEMDIR_KEY_REGISTRY;

export type MemDirKey = {
  key: MemDirKeyName;
  symbol: string; // e.g. "btc", "eth", "*" for global
};

export type MemDirTypedKeys = typeof MEMDIR_KEY_REGISTRY;

/** Build the Redis key string from a MemDirKey descriptor. */
export function buildRedisKey(descriptor: MemDirKey): string {
  const entry = MEMDIR_KEY_REGISTRY[descriptor.key];
  return `${entry.scope}:${descriptor.symbol}:${descriptor.key}`;
}

/** Get the Zod schema for a given key name. */
export function getKeySchema(keyName: MemDirKeyName): z.ZodTypeAny {
  return MEMDIR_KEY_REGISTRY[keyName].schema;
}

/** Get the TTL default for a given key name. */
export function getKeyTtlMs(keyName: MemDirKeyName): number | null {
  return MEMDIR_KEY_REGISTRY[keyName].ttlMs;
}
