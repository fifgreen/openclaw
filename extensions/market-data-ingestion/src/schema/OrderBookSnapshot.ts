import { z } from "zod";

/** A single price level as [price, quantity] */
const PriceLevelSchema = z.tuple([z.number(), z.number()]);

export const OrderBookSnapshotSchema = z.object({
  /** Exchange name, e.g. "binance" or "bybit" */
  exchange: z.string(),
  /** Trading pair in BASE/QUOTE notation, e.g. "BTC/USDT" */
  symbol: z.string(),
  /** Bid levels sorted descending by price (best bid first) */
  bids: z.array(PriceLevelSchema),
  /** Ask levels sorted ascending by price (best ask first) */
  asks: z.array(PriceLevelSchema),
  /** Number of price levels included on each side */
  depth: z.number().int(),
  /** Exchange-assigned sequence ID for gap detection */
  sequenceId: z.number().int(),
  /** Exchange event timestamp in epoch milliseconds */
  timestamp: z.number().int(),
});

export type OrderBookSnapshot = z.infer<typeof OrderBookSnapshotSchema>;
