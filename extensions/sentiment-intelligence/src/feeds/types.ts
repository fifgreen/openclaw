/**
 * Common interface for all sentiment data feed implementations.
 * Each feed is backed by a BullMQ RepeatableJob that calls `poll()` on its schedule.
 */
export interface IFeed<T> {
  /** Unique identifier for this feed — used in BullMQ job IDs and health keys. */
  readonly feedId: string;
  /** Cron expression controlling how often the feed polls (e.g., "0 * /4 * * *" for every 4h). */
  readonly schedule: string;
  /**
   * Fetch the latest data from the upstream source.
   * Throws on unrecoverable errors (bad credentials, schema mismatch).
   * On transient errors, logs a warning and returns the last cached value.
   */
  poll(symbol: string): Promise<T>;
}
