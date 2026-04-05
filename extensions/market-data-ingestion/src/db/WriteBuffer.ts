export interface WriteBufferOptions<T> {
  /** Flush when buffer reaches this many rows (default: 1000) */
  maxRows: number;
  /** Flush on this interval in milliseconds regardless of row count (default: 500) */
  flushIntervalMs: number;
  /**
   * Maximum number of rows allowed in the buffer before the oldest row is dropped.
   * Use `Infinity` to disable drops (required for OB and FundingRate buffers per FR-023).
   */
  maxQueueDepth: number;
  /** Async callback invoked with the batch of rows to persist */
  onFlush: (rows: T[]) => Promise<void>;
}

/**
 * Generic write buffer that batches rows and flushes them via `onFlush` either
 * when `maxRows` is reached or `flushIntervalMs` elapses, whichever comes first.
 *
 * When `maxQueueDepth` is finite and the buffer exceeds it, the oldest row is
 * dropped and a warning is logged with a running drop count.
 *
 * `maxQueueDepth: Infinity` disables the drop policy (required for OB and
 * FundingRate buffers so no data is ever silently lost).
 */
export class WriteBuffer<T> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private dropCount = 0;
  private runningFlush: Promise<void> | null = null;
  private readonly options: WriteBufferOptions<T>;

  constructor(options: WriteBufferOptions<T>) {
    this.options = options;
  }

  /** Start the interval-based flush timer. Must be called before pushing rows. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.triggerFlush();
    }, this.options.flushIntervalMs);
  }

  /**
   * Push a row into the buffer. If `maxRows` is reached, flushes immediately.
   * If `maxQueueDepth` is exceeded, the oldest row is dropped with a warning.
   */
  push(row: T): void {
    const { maxRows, maxQueueDepth } = this.options;

    if (isFinite(maxQueueDepth) && this.buffer.length >= maxQueueDepth) {
      // Drop the oldest row to make room
      this.buffer.shift();
      this.dropCount++;
      console.warn(
        `[WriteBuffer] backpressure: dropped oldest row (total drops: ${this.dropCount})`,
      );
    }

    this.buffer.push(row);

    if (this.buffer.length >= maxRows) {
      this.triggerFlush();
    }
  }

  /**
   * Stop the interval timer and flush any remaining rows in the buffer.
   * Awaiting `stop()` guarantees all buffered rows are handed to `onFlush`.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for any in-progress flush to complete, then drain all remaining rows.
    if (this.runningFlush !== null) await this.runningFlush;
    await this.flushAll();
  }

  /**
   * Start a flush chain if one is not already running.
   * The chain loops until the buffer is empty so that rows pushed during
   * an async flush are still picked up without starting a second chain.
   */
  private triggerFlush(): void {
    if (this.runningFlush !== null) return;
    this.runningFlush = this.flushAll().finally(() => {
      this.runningFlush = null;
    });
  }

  /** Drain the buffer page-by-page until empty. */
  private async flushAll(): Promise<void> {
    while (this.buffer.length > 0) {
      const rows = this.buffer.splice(0, this.options.maxRows);
      try {
        await this.options.onFlush(rows);
      } catch (err: unknown) {
        // Re-queue the failed batch at the front so it can be retried later
        // without reordering it behind rows that arrived during the flush.
        this.buffer = rows.concat(this.buffer);
        console.warn("[WriteBuffer] flush error:", err);
        break;
      }
    }
  }
}
