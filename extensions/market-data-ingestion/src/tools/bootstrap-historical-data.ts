import { HistoricalBootstrap } from "../bootstrap/HistoricalBootstrap.js";
import { rateLimitedRest } from "../ratelimit/rest.js";

/**
 * Tool handler: bootstrap_historical_data
 *
 * Instantiates HistoricalBootstrap and runs a backfill for the given symbols
 * and time range. Returns status and import count on success.
 */
export async function bootstrapHistoricalDataHandler(
  symbols: string[],
  days: number = 7,
): Promise<{ status: "ok"; imported: number } | { status: "error"; message: string }> {
  try {
    const bootstrap = new HistoricalBootstrap({ rateLimitedRest });
    const result = await bootstrap.run(symbols, days);
    return { status: "ok", imported: result.imported };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build the OpenClaw tool definition for `bootstrap_historical_data`. */
export function buildBootstrapHistoricalDataTool() {
  return {
    name: "bootstrap_historical_data",
    label: "Bootstrap Historical Data",
    description:
      "Backfills historical 1-minute candle data for the specified symbols into TimescaleDB. " +
      "Idempotent — re-running skips already-populated intervals. " +
      "Rate-limited at 50% quota to avoid starving live market data feeds.",
    parameters: {
      type: "object" as const,
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          description: 'Array of trading pairs in BASE/QUOTE format, e.g. ["BTC/USDT", "ETH/USDT"]',
        },
        days: {
          type: "number",
          description: "Number of days to backfill (default: 7)",
        },
      },
      required: ["symbols"] as string[],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const symbols = Array.isArray(params["symbols"])
        ? (params["symbols"] as unknown[]).map(String)
        : [];
      const days = typeof params["days"] === "number" ? params["days"] : 7;
      const result = await bootstrapHistoricalDataHandler(symbols, days);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
