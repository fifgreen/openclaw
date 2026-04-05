import { queryOHLCV } from "../db/queries.js";
import type { OHLCV } from "../schema/OHLCV.js";

/**
 * Tool handler: get_ohlcv
 *
 * Returns OHLCV candles from TimescaleDB continuous aggregates.
 * Returns a typed error if no data is available.
 */
export async function getOHLCVHandler(
  symbol: string,
  timeframe: "1m" | "5m" | "1h",
  limit: number = 100,
): Promise<OHLCV[] | { error: "no_data"; message: string }> {
  const rows = await queryOHLCV(symbol, timeframe, limit);
  if (rows.length === 0) {
    return {
      error: "no_data",
      message: `No ${timeframe} candles found for ${symbol}. Run bootstrap_historical_data to seed initial data.`,
    };
  }
  return rows;
}

/** Build the OpenClaw tool definition for `get_ohlcv`. */
export function buildGetOHLCVTool() {
  return {
    name: "get_ohlcv",
    label: "Get OHLCV",
    description:
      "Returns OHLCV (open/high/low/close/volume) candles for a trading symbol from TimescaleDB. " +
      "Available timeframes: 1m, 5m, 1h. Default limit: 100 candles.",
    parameters: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: 'Trading pair in BASE/QUOTE format, e.g. "BTC/USDT"',
        },
        timeframe: {
          type: "string",
          enum: ["1m", "5m", "1h"],
          description: "Candle timeframe",
        },
        limit: {
          type: "number",
          description: "Maximum number of candles to return (default: 100)",
        },
      },
      required: ["symbol", "timeframe"] as string[],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const symbol = String(params["symbol"] ?? "");
      const timeframe = (params["timeframe"] as "1m" | "5m" | "1h") ?? "1m";
      const limit = typeof params["limit"] === "number" ? params["limit"] : 100;
      const result = await getOHLCVHandler(symbol, timeframe, limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
