import type { Pool } from "pg";

const MIN_SAMPLE_COUNT = 10;

interface ScoreOutcomeOptions {
  tradeId: string;
  entryTimestamp: string; // ISO 8601
  entrySymbol: string;
  outcome: "profit" | "loss";
}

/**
 * Records whether the sentiment composite at trade entry time correctly predicted the outcome.
 * Queries the sentiment_snapshots table for the nearest row to entryTimestamp.
 */
export async function scoreOutcome(pool: Pool, opts: ScoreOutcomeOptions): Promise<void> {
  const { tradeId: _tradeId, entryTimestamp, entrySymbol, outcome } = opts;

  // For each feed, find the sentiment_snapshot closest to entryTimestamp
  const rows = await pool.query<{
    composite_score: number;
    timestamp: string;
  }>(
    `SELECT composite_score, timestamp
     FROM sentiment_snapshots
     WHERE symbol = $1
       AND timestamp <= $2
     ORDER BY timestamp DESC
     LIMIT 1`,
    [entrySymbol, entryTimestamp],
  );

  if (rows.rows.length === 0) return; // No snapshot available for this trade

  const { composite_score } = rows.rows[0]!;
  // Bullish prediction: composite > 0.5; correct if profit
  const predictedBullish = composite_score > 0.5;
  const wasCorrect =
    (predictedBullish && outcome === "profit") || (!predictedBullish && outcome === "loss");

  const windowStart = new Date(entryTimestamp);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 1);
  const feedName = "sentiment_composite";

  await pool.query(
    `INSERT INTO feed_accuracy (feed_name, total_predictions, correct_predictions, accuracy_pct, period_days, evaluated_at)
     VALUES ($1, 1, $2, $3, 1, NOW())
     ON CONFLICT (feed_name, evaluated_at, period_days) DO UPDATE SET
       total_predictions = feed_accuracy.total_predictions + 1,
       correct_predictions = feed_accuracy.correct_predictions + EXCLUDED.correct_predictions,
       accuracy_pct = (feed_accuracy.correct_predictions + EXCLUDED.correct_predictions)::float
                      / (feed_accuracy.total_predictions + 1)`,
    [feedName, wasCorrect ? 1 : 0, wasCorrect ? 1.0 : 0.0],
  );
}

/**
 * Returns aggregated accuracy for a feed over the past `days` days.
 * Returns `accuracy30d: null` when sample count is below MIN_SAMPLE_COUNT (10).
 */
export async function queryFeedAccuracyStats(
  pool: Pool,
  feedName: string,
  days: number,
): Promise<{ accuracy30d: number | null; sampleCount: number }> {
  const result = await pool.query<{
    total: string;
    correct: string;
  }>(
    `SELECT SUM(total_predictions) AS total, SUM(correct_predictions) AS correct
     FROM feed_accuracy
     WHERE feed_name = $1
       AND evaluated_at >= NOW() - make_interval(days => $2)`,
    [feedName, days],
  );

  const total = parseInt(result.rows[0]?.total ?? "0", 10);
  const correct = parseInt(result.rows[0]?.correct ?? "0", 10);

  if (total < MIN_SAMPLE_COUNT) {
    return { accuracy30d: null, sampleCount: total };
  }

  return { accuracy30d: correct / total, sampleCount: total };
}
