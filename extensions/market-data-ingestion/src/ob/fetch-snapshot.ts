import type { Exchange } from "../ratelimit/queues.js";
import { rateLimitedRest } from "../ratelimit/rest.js";
import { OrderBookSnapshotSchema, type OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";

/**
 * Fetch an order book snapshot from Binance REST API.
 * Uses the rate limiter with priority=1 (high priority) for gap recovery.
 */
export async function fetchBinanceSnapshot(
  symbol: string,
  depth: number = 20,
): Promise<OrderBookSnapshot> {
  // Convert BASE/QUOTE to Binance raw symbol (e.g. "BTC/USDT" → "BTCUSDT")
  const rawSymbol = symbol.replace("/", "");

  return rateLimitedRest(
    "binance" as Extract<Exchange, "binance">,
    async () => {
      const url = `https://api.binance.com/api/v3/depth?symbol=${rawSymbol}&limit=${depth}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Binance /api/v3/depth returned HTTP ${response.status}`);
      }
      const data = (await response.json()) as Record<string, unknown>;

      const bids = ((data["bids"] as unknown[]) ?? []).map((b: unknown) => {
        const entry = b as [string, string];
        return [Number(entry[0]), Number(entry[1])] as [number, number];
      });
      const asks = ((data["asks"] as unknown[]) ?? []).map((a: unknown) => {
        const entry = a as [string, string];
        return [Number(entry[0]), Number(entry[1])] as [number, number];
      });

      return OrderBookSnapshotSchema.parse({
        exchange: "binance",
        symbol,
        bids,
        asks,
        depth,
        sequenceId: Number(data["lastUpdateId"] ?? 0),
        timestamp: Date.now(),
      });
    },
    { priority: 1 },
  );
}

/**
 * Fetch an order book snapshot from Bybit REST API.
 * Uses the rate limiter with priority=1 (high priority) for gap recovery.
 */
export async function fetchBybitSnapshot(
  symbol: string,
  depth: number = 50,
): Promise<OrderBookSnapshot> {
  const rawSymbol = symbol.replace("/", "");

  return rateLimitedRest(
    "bybit" as Extract<Exchange, "bybit">,
    async () => {
      const url = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${rawSymbol}&limit=${depth}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Bybit /v5/market/orderbook returned HTTP ${response.status}`);
      }
      const data = (await response.json()) as Record<string, unknown>;
      const result = (data["result"] as Record<string, unknown>) ?? {};

      const parseLevels = (arr: unknown): [number, number][] => {
        if (!Array.isArray(arr)) return [];
        return arr.map((b: unknown) => {
          const entry = b as [string, string];
          return [Number(entry[0]), Number(entry[1])] as [number, number];
        });
      };

      const bids = parseLevels(result["b"]);
      const asks = parseLevels(result["a"]);

      return OrderBookSnapshotSchema.parse({
        exchange: "bybit",
        symbol,
        bids,
        asks,
        depth,
        sequenceId: Number(result["seq"] ?? result["u"] ?? 0),
        timestamp: Date.now(),
      });
    },
    { priority: 1 },
  );
}
