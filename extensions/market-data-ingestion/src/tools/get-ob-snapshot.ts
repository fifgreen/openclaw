import type { MarketDataStore } from "../market-data-store.js";
import type { OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";

type Exchange = "binance" | "bybit";

const DEFAULT_DEPTH = 5;
const MAX_DEPTH = 20;

/**
 * Tool handler: get_ob_snapshot
 *
 * Returns the current order book snapshot for a symbol.
 * If exchange is omitted, returns the snapshot from the exchange with the
 * tightest spread (lowest ask - highest bid).
 * Applies depth slicing and validates sort order before returning.
 */
export function getOBSnapshotHandler(
  store: MarketDataStore,
  symbol: string,
  exchange?: Exchange,
  depth: number = DEFAULT_DEPTH,
): OrderBookSnapshot | { error: "not_found" } {
  const effectiveDepth = Math.min(Math.max(1, depth), MAX_DEPTH);
  const exchanges: Exchange[] = exchange ? [exchange] : ["binance", "bybit"];
  const candidates: OrderBookSnapshot[] = [];

  for (const ex of exchanges) {
    const snapshot = store.getOB(ex, symbol);
    if (snapshot !== null) {
      candidates.push(snapshot);
    }
  }

  if (candidates.length === 0) {
    return { error: "not_found" };
  }

  // Pick the snapshot with the tightest spread
  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    const bestSpread = getSpread(best);
    const candidateSpread = getSpread(candidate);
    if (
      candidateSpread !== undefined &&
      (bestSpread === undefined || candidateSpread < bestSpread)
    ) {
      best = candidate;
    }
  }

  // Slice to requested depth and validate sort order
  const bids = best.bids.slice(0, effectiveDepth).sort((a, b) => b[0] - a[0]); // descending

  const asks = best.asks.slice(0, effectiveDepth).sort((a, b) => a[0] - b[0]); // ascending

  return {
    ...best,
    bids,
    asks,
    depth: effectiveDepth,
  };
}

function getSpread(snapshot: OrderBookSnapshot): number | undefined {
  const bestBid = snapshot.bids[0]?.[0];
  const bestAsk = snapshot.asks[0]?.[0];
  if (bestBid === undefined || bestAsk === undefined) return undefined;
  return bestAsk - bestBid;
}

/** Build the OpenClaw tool definition for `get_ob_snapshot`. */
export function buildGetOBSnapshotTool(store: MarketDataStore) {
  return {
    name: "get_ob_snapshot",
    description:
      "Returns the current order book snapshot for a trading symbol. " +
      "If exchange is omitted, returns the snapshot from the exchange with the tightest spread. " +
      "Depth controls how many price levels are returned per side (default: 5, max: 20).",
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
        depth: {
          type: "number",
          description: "Number of price levels to return per side (default: 5, max: 20)",
        },
      },
      required: ["symbol"] as string[],
    },
    execute(_toolCallId: string, params: Record<string, unknown>) {
      const symbol = String(params["symbol"] ?? "");
      const exchange = params["exchange"] as Exchange | undefined;
      const depth = typeof params["depth"] === "number" ? params["depth"] : DEFAULT_DEPTH;
      const result = getOBSnapshotHandler(store, symbol, exchange, depth);
      return JSON.stringify(result);
    },
  };
}
