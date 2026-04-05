import type { MarketDataStore } from "../market-data-store.js";
import type { PriceTick } from "../schema/PriceTick.js";

type Exchange = "binance" | "bybit";

/**
 * Tool handler: get_latest_tick
 *
 * Reads the most recent PriceTick from the in-process MarketDataStore.
 * If `exchange` is provided, reads only that exchange's key.
 * If omitted, checks all active exchanges and returns the one with
 * the most recent `timestamp`.
 *
 * Returns a typed error object if the value is absent or TTL-expired.
 */
export function getLatestTickHandler(
  store: MarketDataStore,
  symbol: string,
  exchange?: Exchange,
): PriceTick | { error: "not_found" } {
  const exchanges: Exchange[] = exchange ? [exchange] : ["binance", "bybit"];
  const candidates: PriceTick[] = [];

  for (const ex of exchanges) {
    const tick = store.getTick(ex, symbol);
    if (tick !== null) {
      candidates.push(tick);
    }
  }

  if (candidates.length === 0) {
    return { error: "not_found" };
  }

  // Return the most recently timestamped tick
  const latest = candidates.reduce((best, t) => (t.timestamp > best.timestamp ? t : best));
  return latest;
}

/** Build the OpenClaw tool definition for `get_latest_tick`. */
export function buildGetLatestTickTool(store: MarketDataStore) {
  return {
    name: "get_latest_tick",
    label: "Get Latest Tick",
    description:
      "Returns the latest price tick for a trading symbol from the live market data feed. " +
      "If exchange is omitted, returns the most recent tick across all active exchanges.",
    parameters: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: 'Trading pair in BASE/QUOTE format, e.g. "BTC/USDT"',
        },
        exchange: {
          type: "string",
          enum: ["binance", "bybit"],
          description: "Limit to a specific exchange (optional)",
        },
      },
      required: ["symbol"] as string[],
    },
    execute(_toolCallId: string, params: Record<string, unknown>) {
      const symbol = String(params["symbol"] ?? "");
      const exchange = params["exchange"] as Exchange | undefined;
      const result = getLatestTickHandler(store, symbol, exchange);
      return Promise.resolve({
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      });
    },
  };
}
