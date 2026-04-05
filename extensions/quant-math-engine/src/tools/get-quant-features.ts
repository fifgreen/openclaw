import type { Pool } from "pg";
import { queryOHLCV } from "../db/queries.js";
import { buildQuantFeatureVector } from "../feature-vector/builder.js";
import type { QuantConfig } from "../feature-vector/builder.js";
import type { FeatureVectorCache } from "../feature-vector/cache.js";
import type { QuantFeatureVector } from "../schema/QuantFeatureVector.js";
import type { OrderFlowDeps } from "./get-order-flow.js";

export interface QuantFeaturesDeps {
  pool: Pool;
  cache: FeatureVectorCache;
  orderFlow: OrderFlowDeps;
  cfg: QuantConfig;
}

export async function getQuantFeaturesHandler(
  deps: QuantFeaturesDeps,
  symbol: string,
  timeframe: "1m" | "5m" | "1h",
): Promise<QuantFeatureVector | { error: "no_data"; message: string }> {
  // Check cache first
  const cached = deps.cache.get(symbol);
  if (cached) return cached;

  const ohlcv = await queryOHLCV(deps.pool, symbol, timeframe, 250);
  if (ohlcv.length === 0) {
    return {
      error: "no_data",
      message: `No ${timeframe} OHLCV data found for ${symbol}. Ensure market-data-ingestion is running.`,
    };
  }

  const ticks = deps.orderFlow.getTicks(symbol);
  const ob = deps.orderFlow.getOBSnapshot(symbol);
  const spreadHistory = deps.orderFlow.getSpreadHistory(symbol);

  const vector = buildQuantFeatureVector(symbol, ohlcv, ticks, ob, spreadHistory, deps.cfg);

  deps.cache.set(symbol, vector);
  return vector;
}

/** Build the OpenClaw tool definition for `get_quant_features`. */
export function buildGetQuantFeaturesTool(deps: QuantFeaturesDeps) {
  return {
    name: "get_quant_features",
    label: "Get Quant Features",
    description:
      "Returns a full QuantFeatureVector for a trading symbol: technical indicators (EMA, RSI, MACD, Bollinger, " +
      "Stochastic RSI, ADX, ATR), live order flow analytics (OB imbalance, CVD, trade flow, large trades), " +
      "statistical models (realized vol, Hurst exponent, regime), and risk metrics (VaR 95/99, drawdown, " +
      "Kelly fraction, max position size). Results are cached for 1 second to avoid repeated computation.",
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
          description: "OHLCV candle timeframe for indicator computation (default: 1h)",
        },
      },
      required: ["symbol"] as string[],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const symbol = String(params["symbol"] ?? "");
      const timeframe = (params["timeframe"] as "1m" | "5m" | "1h") ?? "1h";
      const result = await getQuantFeaturesHandler(deps, symbol, timeframe);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
