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
}

export function createMarketDataStore(): MarketDataStore {
  const ticks = new Map<string, Entry<PriceTick>>();
  const obs = new Map<string, Entry<OrderBookSnapshot>>();
  const funding = new Map<string, Entry<FundingRate>>();

  function isAlive<T>(entry: Entry<T> | undefined): entry is Entry<T> {
    return entry !== undefined && entry.expireAt > Date.now();
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
      return isAlive(entry) ? entry.value : null;
    },
    setOB(exchange, symbol, snapshot) {
      obs.set(`${exchange}:ob:${symbol}`, {
        value: snapshot,
        expireAt: Date.now() + OB_TTL_MS,
      });
    },
    getOB(exchange, symbol) {
      const entry = obs.get(`${exchange}:ob:${symbol}`);
      return isAlive(entry) ? entry.value : null;
    },
    setFunding(exchange, symbol, rate) {
      funding.set(`${exchange}:funding:${symbol}`, {
        value: rate,
        expireAt: Date.now() + FUNDING_TTL_MS,
      });
    },
    getFunding(exchange, symbol) {
      const entry = funding.get(`${exchange}:funding:${symbol}`);
      return isAlive(entry) ? entry.value : null;
    },
  };
}
