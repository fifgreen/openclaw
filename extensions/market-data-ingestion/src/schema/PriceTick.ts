import { z } from "zod";

export const PriceTickSchema = z.object({
  /** Exchange name, e.g. "binance" or "bybit" */
  exchange: z.string(),
  /** Trading pair in BASE/QUOTE notation, e.g. "BTC/USDT" */
  symbol: z.string(),
  /** Last trade price */
  price: z.number(),
  /** Trade quantity */
  quantity: z.number(),
  /** Taker side of the trade */
  side: z.enum(["buy", "sell"]),
  /** Exchange-assigned trade ID */
  tradeId: z.string(),
  /** Exchange event timestamp in epoch milliseconds */
  timestamp: z.number().int(),
  /** Local receipt timestamp in epoch milliseconds */
  localTimestamp: z.number().int(),
});

export type PriceTick = z.infer<typeof PriceTickSchema>;
