import type { Pool, QueryResultRow } from "pg";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

async function queryRows<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  values?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(sql, values);
  return result.rows;
}

// ---------------------------------------------------------------------------
// macro_snapshots
// ---------------------------------------------------------------------------

export interface MacroSnapshotRow {
  series_id: string;
  value: number;
  unit: string;
  effective_date: string; // YYYY-MM-DD
}

/**
 * Upserts a macro snapshot row. On conflict (series_id, effective_date) updates
 * the value and unit.
 */
export async function upsertMacroSnapshot(pool: Pool, row: MacroSnapshotRow): Promise<void> {
  await pool.query(
    `INSERT INTO macro_snapshots (series_id, value, unit, effective_date)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (series_id, effective_date)
     DO UPDATE SET value = EXCLUDED.value, unit = EXCLUDED.unit`,
    [row.series_id, row.value, row.unit, row.effective_date],
  );
}

/**
 * Returns the latest row per series_id, ordered by series_id for deterministic output.
 */
export async function queryLatestMacroSnapshot(pool: Pool): Promise<MacroSnapshotRow[]> {
  return queryRows<MacroSnapshotRow>(
    pool,
    `SELECT DISTINCT ON (series_id) series_id, value, unit, effective_date
     FROM macro_snapshots
     ORDER BY series_id, effective_date DESC`,
  );
}

// ---------------------------------------------------------------------------
// sentiment_snapshots
// ---------------------------------------------------------------------------

export interface SentimentSnapshotRow {
  symbol: string;
  fear_greed_score: number;
  fear_greed_label: string;
  twitter_score: number;
  tweet_volume: number;
  reddit_score: number;
  reddit_post_volume: number;
  funding_bias: string;
  funding_rate: number;
  composite_score: number;
  regime: string;
  recorded_at?: string;
}

/**
 * Inserts a sentiment snapshot. recorded_at defaults to NOW() on the DB side.
 */
export async function insertSentimentSnapshot(
  pool: Pool,
  row: Omit<SentimentSnapshotRow, "recorded_at">,
): Promise<void> {
  await pool.query(
    `INSERT INTO sentiment_snapshots
     (symbol, fear_greed_score, fear_greed_label, twitter_score, tweet_volume,
      reddit_score, reddit_post_volume, funding_bias, funding_rate,
      composite_score, regime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      row.symbol,
      row.fear_greed_score,
      row.fear_greed_label,
      row.twitter_score,
      row.tweet_volume,
      row.reddit_score,
      row.reddit_post_volume,
      row.funding_bias,
      row.funding_rate,
      row.composite_score,
      row.regime,
    ],
  );
}

// ---------------------------------------------------------------------------
// news_events
// ---------------------------------------------------------------------------

export interface NewsEventRow {
  headline: string;
  source: string;
  symbols: string[];
  sentiment: string;
  relevance_score: number;
  url: string;
  published_at: string; // ISO 8601
}

/**
 * Inserts a news event. ON CONFLICT (dedup index on normalized headline + 5-min
 * bucket) does nothing.
 */
export async function insertNewsEvent(pool: Pool, event: NewsEventRow): Promise<void> {
  await pool.query(
    `INSERT INTO news_events (headline, source, symbols, sentiment, relevance_score, url, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      event.headline,
      event.source,
      event.symbols,
      event.sentiment,
      event.relevance_score,
      event.url,
      event.published_at,
    ],
  );
}

export interface QueryNewsEventsOptions {
  symbol?: string;
  limit?: number;
  sinceIso?: string;
}

/**
 * Queries recent news events for a symbol (or all symbols if not provided).
 * Results are ordered by published_at DESC.
 */
export async function queryNewsEvents(
  pool: Pool,
  opts: QueryNewsEventsOptions = {},
): Promise<NewsEventRow[]> {
  const { symbol, limit = 50, sinceIso } = opts;

  if (symbol && sinceIso) {
    return queryRows<NewsEventRow>(
      pool,
      `SELECT headline, source, symbols, sentiment, relevance_score, url, published_at
       FROM news_events
       WHERE symbols @> ARRAY[$1]::text[] AND published_at >= $2
       ORDER BY published_at DESC
       LIMIT $3`,
      [symbol, sinceIso, limit],
    );
  }

  if (symbol) {
    return queryRows<NewsEventRow>(
      pool,
      `SELECT headline, source, symbols, sentiment, relevance_score, url, published_at
       FROM news_events
       WHERE symbols @> ARRAY[$1]::text[]
       ORDER BY published_at DESC
       LIMIT $2`,
      [symbol, limit],
    );
  }

  return queryRows<NewsEventRow>(
    pool,
    `SELECT headline, source, symbols, sentiment, relevance_score, url, published_at
     FROM news_events
     ORDER BY published_at DESC
     LIMIT $1`,
    [limit],
  );
}

// ---------------------------------------------------------------------------
// feed_accuracy
// ---------------------------------------------------------------------------

export interface FeedAccuracyRow {
  feed_name: string;
  total_predictions: number;
  correct_predictions: number;
  accuracy_pct: number;
  period_days: number;
  evaluated_at: string;
}

/** Upserts feed accuracy metrics, keyed on (feed_name, period_days, evaluated_at date). */
export async function upsertFeedAccuracy(pool: Pool, row: FeedAccuracyRow): Promise<void> {
  await pool.query(
    `INSERT INTO feed_accuracy
     (feed_name, total_predictions, correct_predictions, accuracy_pct, period_days, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (feed_name, period_days, evaluated_at::date)
     DO UPDATE SET
       total_predictions = EXCLUDED.total_predictions,
       correct_predictions = EXCLUDED.correct_predictions,
       accuracy_pct = EXCLUDED.accuracy_pct`,
    [
      row.feed_name,
      row.total_predictions,
      row.correct_predictions,
      row.accuracy_pct,
      row.period_days,
      row.evaluated_at,
    ],
  );
}

/** Returns the latest accuracy row for each feed_name, for a given period_days. */
export async function queryFeedAccuracy(pool: Pool, periodDays = 30): Promise<FeedAccuracyRow[]> {
  return queryRows<FeedAccuracyRow>(
    pool,
    `SELECT DISTINCT ON (feed_name) feed_name, total_predictions, correct_predictions,
            accuracy_pct, period_days, evaluated_at
     FROM feed_accuracy
     WHERE period_days = $1
     ORDER BY feed_name, evaluated_at DESC`,
    [periodDays],
  );
}
