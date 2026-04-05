import type { Pool } from "pg";
import { queryOHLCV } from "../db/queries.js";
import { computeADX } from "../indicators/adx.js";
import { computeATR } from "../indicators/atr.js";
import { computeBollinger } from "../indicators/bollinger.js";
import { computeEMA } from "../indicators/ema.js";
import { computeMACD } from "../indicators/macd.js";
import { computeRSI } from "../indicators/rsi.js";
import { computeStochRSI } from "../indicators/stochastic-rsi.js";
import type { IndicatorSet } from "../schema/QuantFeatureVector.js";

function finite(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  return Number.isFinite(n) ? n : null;
}

export async function getIndicatorsHandler(
  pool: Pool,
  symbol: string,
  timeframe: "1m" | "5m" | "1h",
  limit: number,
): Promise<IndicatorSet | { error: "no_data"; message: string }> {
  const rows = await queryOHLCV(pool, symbol, timeframe, limit);
  if (rows.length === 0) {
    return {
      error: "no_data",
      message: `No ${timeframe} OHLCV data found for ${symbol}. Ensure market-data-ingestion is running.`,
    };
  }

  const closes = rows.map((r) => r.close);
  const macd = computeMACD(closes);
  const bollinger = computeBollinger(closes, 20, 2);

  const indicators: IndicatorSet = {
    ema9: finite(computeEMA(closes, 9)),
    ema21: finite(computeEMA(closes, 21)),
    ema50: finite(computeEMA(closes, 50)),
    ema200: finite(computeEMA(closes, 200)),
    rsi: finite(computeRSI(closes, 14)),
    macdLine: macd ? finite(macd.macdLine) : null,
    macdSignal: macd ? finite(macd.signalLine) : null,
    macdHistogram: macd ? finite(macd.histogram) : null,
    bollingerUpper: bollinger ? finite(bollinger.upper) : null,
    bollingerMiddle: bollinger ? finite(bollinger.middle) : null,
    bollingerLower: bollinger ? finite(bollinger.lower) : null,
    bollingerPosition: bollinger ? finite(bollinger.position) : null,
    stochRsi: finite(computeStochRSI(closes, 14)),
    adx: finite(computeADX(rows, 14)),
    atr: finite(computeATR(rows, 14)),
  };

  return indicators;
}

/** Build the OpenClaw tool definition for `get_indicators`. */
export function buildGetIndicatorsTool(pool: Pool) {
  return {
    name: "get_indicators",
    label: "Get Indicators",
    description:
      "Returns technical indicators (EMA, RSI, MACD, Bollinger Bands, Stochastic RSI, ADX, ATR) " +
      "for a trading symbol computed from TimescaleDB OHLCV data. " +
      "Timeframes: 1m, 5m, 1h. Default limit: 250 candles.",
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
          description: "Candle timeframe (default: 1h)",
        },
        limit: {
          type: "number",
          description: "Candles to fetch (default: 250)",
        },
      },
      required: ["symbol"] as string[],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const symbol = String(params["symbol"] ?? "");
      const timeframe = (params["timeframe"] as "1m" | "5m" | "1h") ?? "1h";
      const limit = typeof params["limit"] === "number" ? params["limit"] : 250;
      const result = await getIndicatorsHandler(pool, symbol, timeframe, limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
