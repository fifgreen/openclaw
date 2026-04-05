import { query } from "../db/client.js";
import { batchInsertTicks } from "../db/queries.js";
import type { Exchange } from "../ratelimit/queues.js";
import type { rateLimitedRest } from "../ratelimit/rest.js";
import type { PriceTick } from "../schema/PriceTick.js";

type Logger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

type RateLimitedRestFn = typeof rateLimitedRest;

export interface HistoricalBootstrapOptions {
  rateLimitedRest: RateLimitedRestFn;
  logger?: Logger;
}

const CHUNK_SIZE = 1000;
const MS_PER_MINUTE = 60_000;

/**
 * HistoricalBootstrap backfills historical 1m candles for a set of symbols.
 *
 * Idempotency: reads MAX(timestamp) from price_ticks per symbol to determine
 * the existing coverage range, then fetches only the missing range.
 *
 * Rate limiting: all REST calls use `quotaFraction: 0.5` to avoid starving
 * live market data requests during bootstrap.
 */
export class HistoricalBootstrap {
  private readonly rateLimitedRest: RateLimitedRestFn;
  private readonly logger: Logger;

  constructor(opts: HistoricalBootstrapOptions) {
    this.rateLimitedRest = opts.rateLimitedRest;
    this.logger = opts.logger ?? {
      info: (msg, meta) => console.info(msg, meta),
      warn: (msg, meta) => console.warn(msg, meta),
    };
  }

  /**
   * Backfill historical data for the given symbols.
   * @param symbols - Array of BASE/QUOTE symbol strings, e.g. ["BTC/USDT"]
   * @param days    - Number of days to backfill (default: 7)
   */
  async run(symbols: string[], days: number = 7): Promise<{ imported: number }> {
    let totalImported = 0;

    for (const symbol of symbols) {
      const imported = await this.backfillSymbol(symbol, days);
      totalImported += imported;
    }

    return { imported: totalImported };
  }

  private async backfillSymbol(symbol: string, days: number): Promise<number> {
    const now = Date.now();
    const targetStart = now - days * 24 * 60 * MS_PER_MINUTE;

    // Check existing coverage (idempotency)
    const rows = await query<{ max_ts: string | null }>(
      `SELECT MAX(timestamp) AS max_ts FROM price_ticks WHERE symbol = $1`,
      [symbol],
    );
    const existing = rows[0]?.max_ts ? new Date(rows[0].max_ts).getTime() : null;
    const rangeStart = existing !== null ? existing + MS_PER_MINUTE : targetStart;

    if (rangeStart >= now) {
      this.logger.info(`[Bootstrap] ${symbol} already up to date`, { symbol });
      return 0;
    }

    this.logger.info(`[Bootstrap] backfilling ${symbol}`, {
      symbol,
      rangeStart: new Date(rangeStart).toISOString(),
      rangeEnd: new Date(now).toISOString(),
    });

    let imported = 0;
    let cursor = rangeStart;

    while (cursor < now) {
      const chunkEnd = Math.min(cursor + CHUNK_SIZE * MS_PER_MINUTE, now);
      const ticks = await this.fetchKlines(symbol, cursor, chunkEnd);
      if (ticks.length === 0) break;

      await batchInsertTicks(ticks);
      imported += ticks.length;
      // Always advance to at least chunkEnd to prevent infinite loops when
      // exchange returns data with timestamps behind the current cursor.
      const lastTickNext = ticks[ticks.length - 1]!.timestamp + MS_PER_MINUTE;
      cursor = Math.max(lastTickNext, chunkEnd);

      this.logger.info(`[Bootstrap] chunk inserted`, {
        symbol,
        rangeStart: new Date(rangeStart).toISOString(),
        rangeEnd: new Date(cursor).toISOString(),
        rowsInserted: ticks.length,
      });
    }

    return imported;
  }

  /**
   * Fetch 1m klines from Binance (primary) for a time range.
   * Falls back to Bybit if Binance returns an error.
   * Uses quotaFraction: 0.5 to reserve capacity for live data.
   */
  private async fetchKlines(symbol: string, startMs: number, endMs: number): Promise<PriceTick[]> {
    const rawSymbol = symbol.replace("/", "");
    const limit = Math.min(CHUNK_SIZE, Math.ceil((endMs - startMs) / MS_PER_MINUTE));

    try {
      return await this.rateLimitedRest(
        "binance" as Extract<Exchange, "binance">,
        async () => {
          const url =
            `https://api.binance.com/api/v3/klines` +
            `?symbol=${rawSymbol}&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=${limit}`;
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Binance klines HTTP ${response.status}`);
          }
          const data = (await response.json()) as unknown[][];
          return data.map(
            (k): PriceTick => ({
              exchange: "binance",
              symbol,
              price: Number(k[4]), // close price
              quantity: Number(k[5]), // volume
              side: "buy", // synthetic — direction not available in klines
              tradeId: `kline-${k[0]}`,
              timestamp: Number(k[0]),
              localTimestamp: Date.now(),
            }),
          );
        },
        { quotaFraction: 0.5 },
      );
    } catch (err) {
      this.logger.warn(`[Bootstrap] Binance klines failed, trying Bybit`, {
        symbol,
        error: String(err),
      });
      return await this.rateLimitedRest(
        "bybit" as Extract<Exchange, "bybit">,
        async () => {
          const url =
            `https://api.bybit.com/v5/market/kline` +
            `?category=linear&symbol=${rawSymbol}&interval=1&start=${startMs}&end=${endMs}&limit=${limit}`;
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Bybit klines HTTP ${response.status}`);
          }
          const data = (await response.json()) as { result: { list: string[][] } };
          return (data.result.list ?? []).map(
            (k: string[]): PriceTick => ({
              exchange: "bybit",
              symbol,
              price: Number(k[4]),
              quantity: Number(k[5]),
              side: "buy",
              tradeId: `kline-${k[0]}`,
              timestamp: Number(k[0]),
              localTimestamp: Date.now(),
            }),
          );
        },
        { quotaFraction: 0.5 },
      );
    }
  }
}
