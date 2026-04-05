import type { FundingRate } from "../schema/FundingRate.js";
import type { OHLCV } from "../schema/OHLCV.js";
import type { OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";
import type { PriceTick } from "../schema/PriceTick.js";
import { query } from "./client.js";

// ───────────────────────────────────────────────────────────────────────────
// Price ticks
// ───────────────────────────────────────────────────────────────────────────

interface PriceTickRow {
  timestamp: Date;
  exchange: string;
  symbol: string;
  price: string;
  quantity: string;
  side: string;
  trade_id: string;
  local_timestamp: Date;
}

/** Batch-insert price ticks. Ignores duplicate (timestamp, exchange, symbol, trade_id) rows. */
export async function batchInsertTicks(rows: PriceTick[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const r of rows) {
    placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    values.push(
      new Date(r.timestamp),
      r.exchange,
      r.symbol,
      r.price,
      r.quantity,
      r.side,
      r.tradeId,
      new Date(r.localTimestamp),
    );
  }
  await query<PriceTickRow>(
    `INSERT INTO price_ticks (timestamp, exchange, symbol, price, quantity, side, trade_id, local_timestamp)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT DO NOTHING`,
    values,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Order book snapshots
// ───────────────────────────────────────────────────────────────────────────

interface OBSnapshotRow {
  timestamp: Date;
  exchange: string;
  symbol: string;
  depth: number;
  sequence_id: string;
  bids: unknown;
  asks: unknown;
}

/** Batch-insert OB snapshots. Ignores duplicates. */
export async function batchInsertOBSnapshots(rows: OrderBookSnapshot[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const r of rows) {
    placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    values.push(
      new Date(r.timestamp),
      r.exchange,
      r.symbol,
      r.depth,
      r.sequenceId,
      JSON.stringify(r.bids),
      JSON.stringify(r.asks),
    );
  }
  await query<OBSnapshotRow>(
    `INSERT INTO ob_snapshots (timestamp, exchange, symbol, depth, sequence_id, bids, asks)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT DO NOTHING`,
    values,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Funding rates
// ───────────────────────────────────────────────────────────────────────────

interface FundingRateRow {
  timestamp: Date;
  exchange: string;
  symbol: string;
  rate: string;
  next_funding_time: Date;
}

/** Batch-insert funding rates. Ignores duplicates. */
export async function batchInsertFundingRates(rows: FundingRate[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const r of rows) {
    placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    values.push(new Date(r.timestamp), r.exchange, r.symbol, r.rate, new Date(r.nextFundingTime));
  }
  await query<FundingRateRow>(
    `INSERT INTO funding_rates (timestamp, exchange, symbol, rate, next_funding_time)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (timestamp, exchange, symbol) DO NOTHING`,
    values,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// OHLCV
// ───────────────────────────────────────────────────────────────────────────

interface OHLCVRow {
  timestamp: Date;
  symbol: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

const OHLCV_VIEW: Record<string, string> = {
  "1m": "ohlcv_1m",
  "5m": "ohlcv_5m",
  "1h": "ohlcv_1h",
};

/** Query OHLCV candles from the matching continuous aggregate view. */
export async function queryOHLCV(
  symbol: string,
  timeframe: "1m" | "5m" | "1h",
  limit: number,
): Promise<OHLCV[]> {
  const view = OHLCV_VIEW[timeframe];
  if (!view) throw new Error(`Unknown timeframe: ${timeframe}`);
  const rows = await query<OHLCVRow>(
    `SELECT timestamp, symbol, open, high, low, close, volume
     FROM (
       SELECT timestamp, symbol, open, high, low, close, volume
       FROM ${view}
       WHERE symbol = $1
       ORDER BY timestamp DESC
       LIMIT $2
     ) AS latest
     ORDER BY timestamp ASC`,
    [symbol, limit],
  );
  return rows.map((r) => ({
    symbol: r.symbol,
    timeframe,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    timestamp: r.timestamp.getTime(),
  }));
}
