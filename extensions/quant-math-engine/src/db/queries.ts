import type pg from "pg";
import { query } from "./client.js";

type Pool = InstanceType<typeof import("pg").Pool>;

export interface OHLCVRow {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const VIEW_MAP: Record<string, string> = {
  "1m": "ohlcv_1m",
  "5m": "ohlcv_5m",
  "1h": "ohlcv_1h",
};

/**
 * Queries OHLCV candles from the TimescaleDB continuous aggregate views
 * created by the market-data-ingestion plugin.
 *
 * Returns candles in ascending timestamp order, filtered to only include
 * rows with all finite numeric values.
 */
export async function queryOHLCV(
  pool: Pool,
  symbol: string,
  timeframe: "1m" | "5m" | "1h",
  limit: number,
): Promise<OHLCVRow[]> {
  const view = VIEW_MAP[timeframe];
  if (!view) throw new Error(`Unknown timeframe: ${timeframe}`);

  const rows = await query<{
    timestamp: Date | number;
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
    volume: string | number;
  }>(
    pool,
    `SELECT
       EXTRACT(EPOCH FROM bucket) * 1000 AS timestamp,
       open, high, low, close, volume
     FROM ${view}
     WHERE symbol = $1
     ORDER BY bucket ASC
     LIMIT $2`,
    [symbol, limit],
  );

  const result: OHLCVRow[] = [];
  for (const row of rows) {
    const ts = Number(row.timestamp);
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const volume = Number(row.volume);
    // Filter out any corrupt rows with non-finite values
    if (
      Number.isFinite(ts) &&
      Number.isFinite(open) &&
      Number.isFinite(high) &&
      Number.isFinite(low) &&
      Number.isFinite(close) &&
      Number.isFinite(volume)
    ) {
      result.push({ timestamp: ts, open, high, low, close, volume });
    }
  }
  return result;
}
