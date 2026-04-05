import type { Pool } from "pg";

/**
 * Normalizes a headline for comparison: lowercase, strip non-alphanumeric chars.
 */
function normalize(headline: string): string {
  return headline.toLowerCase().replace(/[^a-z0-9 ]/g, "");
}

/**
 * Truncates an ISO 8601 datetime to the 5-minute bucket, returning a Date.
 * Equivalent to PostgreSQL's `date_trunc('5 minutes', published_at)`.
 */
function truncateTo5Minutes(isoDate: string): Date {
  const d = new Date(isoDate);
  d.setSeconds(0, 0);
  // Round minutes down to nearest 5
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
  return d;
}

/**
 * Checks whether a news event is a duplicate by querying the DB.
 * Compares normalized headline and 5-minute bucket of published_at.
 */
export async function isDuplicate(
  headline: string,
  publishedAt: string,
  pool: Pool,
): Promise<boolean> {
  const normalized = normalize(headline);
  const bucket = truncateTo5Minutes(publishedAt).toISOString();

  const result = await pool.query<{ found: number }>(
    `SELECT 1 AS found
     FROM news_events
     WHERE lower(regexp_replace(headline, '[^a-z0-9 ]', '', 'gi')) = $1
       AND date_trunc('5 minutes', published_at) = $2
     LIMIT 1`,
    [normalized, bucket],
  );

  return result.rows.length > 0;
}
