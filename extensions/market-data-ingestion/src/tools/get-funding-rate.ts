import type { MarketDataStore } from "../market-data-store.js";
import type { FundingRate } from "../schema/FundingRate.js";

type Exchange = "binance" | "bybit";

/**
 * Tool handler: get_funding_rate
 *
 * Returns the current funding rate for a perpetual futures symbol.
 * If exchange is omitted, returns the most recently updated rate across all exchanges.
 * Validates that nextFundingTime > Date.now() before returning.
 */
export function getFundingRateHandler(
  store: MarketDataStore,
  symbol: string,
  exchange?: Exchange,
): FundingRate | { error: "not_found" } {
  const exchanges: Exchange[] = exchange ? [exchange] : ["binance", "bybit"];
  const candidates: FundingRate[] = [];

  for (const ex of exchanges) {
    const rate = store.getFunding(ex, symbol);
    if (rate !== null && rate.nextFundingTime > Date.now()) {
      candidates.push(rate);
    }
  }

  if (candidates.length === 0) {
    return { error: "not_found" };
  }

  // Return the most recently updated
  const latest = candidates.reduce((best, r) => (r.timestamp > best.timestamp ? r : best));
  return latest;
}

/** Build the OpenClaw tool definition for `get_funding_rate`. */
export function buildGetFundingRateTool(store: MarketDataStore) {
  return {
    name: "get_funding_rate",
    description:
      "Returns the current perpetual futures funding rate for a trading symbol. " +
      "If exchange is omitted, returns the most recently updated rate across all active exchanges.",
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
      const result = getFundingRateHandler(store, symbol, exchange);
      return JSON.stringify(result);
    },
  };
}
