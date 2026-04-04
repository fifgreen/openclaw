import { z } from "zod";

export const OHLCVSchema = z.object({
  /** Trading pair in BASE/QUOTE notation, e.g. "BTC/USDT" */
  symbol: z.string(),
  /** Candle timeframe */
  timeframe: z.enum(["1m", "5m", "1h"]),
  /** Opening price */
  open: z.number(),
  /** Highest price in the period */
  high: z.number(),
  /** Lowest price in the period */
  low: z.number(),
  /** Closing price */
  close: z.number(),
  /** Total traded volume in the period */
  volume: z.number(),
  /** Candle open time in epoch milliseconds */
  timestamp: z.number().int(),
});

export type OHLCV = z.infer<typeof OHLCVSchema>;
