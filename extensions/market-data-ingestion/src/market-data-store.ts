import type { FundingRate } from "./schema/FundingRate.js";
import type { OrderBookSnapshot } from "./schema/OrderBookSnapshot.js";
import type { PriceTick } from "./schema/PriceTick.js";

type Exchange = "binance" | "bybit";

interface Entry<T> {
  value: T;
  expireAt: number;
}

/**
 * In-process TTL store for hot-path market data.
 *
 * Keys are dynamic `{exchange}:{type}:{symbol}` paths that cannot be registered
 * in the MemDir key registry. TTL semantics are enforced locally without an
 * external Redis client so the plugin works without a live Redis connection.
 *
 * TTLs (milliseconds):
 *   tick     — 5 000 ms  (≈ 5 s: trade stream ticks at least once/second)
 *   ob       — 5 000 ms  (≈ 5 s: OB state machine pushes on every live update)
 *   funding  — 600 000 ms (≈ 10 min: funding rates change every 8 h)
 */

const TICK_TTL_MS = 5_000;
const OB_TTL_MS = 5_000;
const FUNDING_TTL_MS = 600_000;

export interface MarketDataStore {
  setTick(exchange: Exchange, symbol: string, tick: PriceTick): void;
  getTick(exchange: Exchange, symbol: string): PriceTick | null;
  setOB(exchange: Exchange, symbol: string, snapshot: OrderBookSnapshot): void;
  getOB(exchange: Exchange, symbol: string): OrderBookSnapshot | null;
  setFunding(exchange: Exchange, symbol: string, rate: FundingRate): void;
  getFunding(exchange: Exchange, symbol: string): FundingRate | null;
  /** Run periodic cleanup to remove expired entries and prevent unbounded memory growth */
  startCleanup(): void;
  /** Stop the cleanup timer */
  stopCleanup(): void;
}

export function createMarketDataStore(): MarketDataStore {
  const ticks = new Map<string, Entry<PriceTick>>();
  const obs = new Map<string, Entry<OrderBookSnapshot>>();
  const funding = new Map<string, Entry<FundingRate>>();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function isAlive<T>(entry: Entry<T> | undefined): entry is Entry<T> {
    return entry !== undefined && entry.expireAt > Date.now();
  }

  function cleanupExpiredEntries(): void {
    const now = Date.now();
    for (const [key, entry] of ticks) {
      if (entry.expireAt <= now) ticks.delete(key);
    }
    for (const [key, entry] of obs) {
      if (entry.expireAt <= now) obs.delete(key);
    }
    for (const [key, entry] of funding) {
      if (entry.expireAt <= now) funding.delete(key);
    }
  }

  return {
    setTick(exchange, symbol, tick) {
      ticks.set(`${exchange}:tick:${symbol}`, {
        value: tick,
        expireAt: Date.now() + TICK_TTL_MS,
      });
    },
    getTick(exchange, symbol) {
      const entry = ticks.get(`${exchange}:tick:${symbol}`);
      if (isAlive(entry)) {
        return entry.value;
      } else {
        // Delete expired entry on read
        if (entry) ticks.delete(`${exchange}:tick:${symbol}`);
        return null;
      }
    },
    setOB(exchange, symbol, snapshot) {
      obs.set(`${exchange}:ob:${symbol}`, {
        value: snapshot,
        expireAt: Date.now() + OB_TTL_MS,
      });
    },
    getOB(exchange, symbol) {
      const entry = obs.get(`${exchange}:ob:${symbol}`);
      if (isAlive(entry)) {
        return entry.value;
      } else {
        // Delete expired entry on read
        if (entry) obs.delete(`${exchange}:ob:${symbol}`);
        return null;
      }
    },
    setFunding(exchange, symbol, rate) {
      funding.set(`${exchange}:funding:${symbol}`, {
        value: rate,
        expireAt: Date.now() + FUNDING_TTL_MS,
      });
    },
    getFunding(exchange, symbol) {
      const entry = funding.get(`${exchange}:funding:${symbol}`);
      if (isAlive(entry)) {
        return entry.value;
      } else {
        // Delete expired entry on read
        if (entry) funding.delete(`${exchange}:funding:${symbol}`);
        return null;
      }
    },
    startCleanup() {
      if (cleanupTimer !== null) return;
      // Run cleanup every 60 seconds to prevent unbounded memory growth
      cleanupTimer = setInterval(cleanupExpiredEntries, 60_000);
    },
    stopCleanup() {
      if (cleanupTimer !== null) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
    },
  };
}
