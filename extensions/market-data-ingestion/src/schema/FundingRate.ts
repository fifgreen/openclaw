import { z } from "zod";

export const FundingRateSchema = z.object({
  /** Exchange name, e.g. "binance" or "bybit" */
  exchange: z.string(),
  /** Trading pair in BASE/QUOTE notation, e.g. "BTC/USDT" */
  symbol: z.string(),
  /** Funding rate as a decimal fraction (e.g. 0.0001 = 0.01%) */
  rate: z.number(),
  /** Unix timestamp of the next funding settlement in epoch milliseconds */
  nextFundingTime: z.number().int(),
  /** Exchange event timestamp in epoch milliseconds */
  timestamp: z.number().int(),
});

export type FundingRate = z.infer<typeof FundingRateSchema>;
