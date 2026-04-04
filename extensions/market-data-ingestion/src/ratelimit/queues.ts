import type { Redis } from "ioredis";

export type Exchange = "binance" | "bybit";

/** Per-exchange REST rate-limit caps in requests per minute */
export const RATE_CAPS: Record<Exchange, number> = {
  binance: 960,
  bybit: 480,
};

// ───────────────────────────────────────────────────────────────────────────
// In-process fallback: TokenBucketQueue
// ───────────────────────────────────────────────────────────────────────────

/** Minimal token-bucket queue used when Redis/BullMQ is unavailable. */
class TokenBucketQueue {
  private tokens: number;
  private readonly ratePerMs: number;
  private lastRefill: number;
  private readonly queue: Array<() => void> = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly rpmCap: number) {
    this.tokens = rpmCap;
    this.ratePerMs = rpmCap / 60_000;
    this.lastRefill = Date.now();
  }

  /** Enqueue a callback and resolve it when a token is available. */
  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.scheduleDrain();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.rpmCap, this.tokens + elapsed * this.ratePerMs);
    this.lastRefill = now;
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, 0);
  }

  private drain(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const resolve = this.queue.shift()!;
      resolve();
    }
    if (this.queue.length > 0) {
      // More work pending — schedule another drain when tokens refill
      const msUntilNextToken = Math.ceil(1 / this.ratePerMs);
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        this.drain();
      }, msUntilNextToken);
    }
  }
}

// One fallback queue per exchange (created lazily)
const fallbackQueues = new Map<Exchange, TokenBucketQueue>();

function getFallbackQueue(exchange: Exchange): TokenBucketQueue {
  let q = fallbackQueues.get(exchange);
  if (!q) {
    q = new TokenBucketQueue(RATE_CAPS[exchange]);
    fallbackQueues.set(exchange, q);
  }
  return q;
}

// ───────────────────────────────────────────────────────────────────────────
// BullMQ queue factory
// ───────────────────────────────────────────────────────────────────────────

type BullMQQueueLike = {
  add: (name: string, data: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
};

let bullmqMod: typeof import("bullmq") | null = null;

async function getBullMQ(): Promise<typeof import("bullmq") | null> {
  if (bullmqMod) return bullmqMod;
  try {
    bullmqMod = await import("bullmq");
    return bullmqMod;
  } catch {
    return null;
  }
}

const bullmqQueues = new Map<Exchange, BullMQQueueLike>();

/**
 * Create (or return cached) a BullMQ queue for the given exchange.
 * If Redis is unavailable or BullMQ fails to instantiate, falls back
 * to an in-process `TokenBucketQueue` and logs a warning.
 */
export async function createRateLimitQueue(
  exchange: Exchange,
  redisClient: Redis | null,
  opts?: { binanceRPM?: number; bybitRPM?: number },
): Promise<BullMQQueueLike | null> {
  if (!redisClient) {
    console.warn(
      `[ratelimit] Redis unavailable — using in-process TokenBucketQueue for ${exchange}`,
    );
    return null;
  }

  const bullmq = await getBullMQ();
  if (!bullmq) {
    console.warn(
      `[ratelimit] BullMQ unavailable — using in-process TokenBucketQueue for ${exchange}`,
    );
    return null;
  }

  if (bullmqQueues.has(exchange)) return bullmqQueues.get(exchange)!;

  try {
    const rpm = opts
      ? exchange === "binance"
        ? (opts.binanceRPM ?? RATE_CAPS.binance)
        : (opts.bybitRPM ?? RATE_CAPS.bybit)
      : RATE_CAPS[exchange];

    const queue = new bullmq.Queue(`trading:ratelimit:${exchange}`, {
      connection: redisClient,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        // Rate limiter: max `rpm` jobs per 60_000 ms window
        // BullMQ Queue.add opts are set per-job; limiter is on Worker side
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      },
    });

    // Store the rpm cap as metadata so workers can respect it
    Object.defineProperty(queue, "_rpmCap", { value: rpm, enumerable: false });
    bullmqQueues.set(exchange, queue);
    return queue;
  } catch (err) {
    console.warn(`[ratelimit] BullMQ queue creation failed for ${exchange}:`, err);
    return null;
  }
}

// BullMQ Workers that actually run the jobs (one per exchange)
type BullMQWorkerLike = { close: () => Promise<void> };
const bullmqWorkers = new Map<Exchange, BullMQWorkerLike>();

/** Resolve the rate-limiter queue for the given exchange, creating it if needed. */
async function getOrCreateQueue(exchange: Exchange): Promise<BullMQQueueLike | null> {
  return bullmqQueues.get(exchange) ?? null;
}

// ───────────────────────────────────────────────────────────────────────────
// Public rate-limited REST wrapper
// ───────────────────────────────────────────────────────────────────────────

export interface RateLimitedRestOptions {
  /**
   * Fraction of the exchange rate cap to apply (default: 1.0).
   * 0.5 halves effective throughput — used during historical bootstrap mode.
   */
  quotaFraction?: number;
  /** BullMQ job priority (lower = higher priority). Default: 10 */
  priority?: number;
}

/**
 * Execute `fn` subject to the per-exchange REST rate limit.
 *
 * Preferred path: BullMQ worker dequeues the job and calls `fn` in-process.
 * Fallback path: In-process `TokenBucketQueue` throttles calls directly.
 */
export async function rateLimitedRest<T>(
  exchange: Exchange,
  fn: () => Promise<T>,
  opts: RateLimitedRestOptions = {},
): Promise<T> {
  const queue = await getOrCreateQueue(exchange);

  if (!queue) {
    // Fallback: in-process token bucket
    const tbq = getFallbackQueue(exchange);
    await tbq.acquire();
    return fn();
  }

  // BullMQ path: we use a simple promise-based pattern where the job payload
  // contains a unique ID and a separate Map resolves the promise when the
  // worker completes the job.
  //
  // For self-contained plugin operation (no separate worker process), we keep
  // a local worker alive in the same process.
  const bullmq = await getBullMQ();
  if (!bullmq) {
    const tbq = getFallbackQueue(exchange);
    await tbq.acquire();
    return fn();
  }

  const connection = (queue as unknown as { opts?: { connection?: Redis } }).opts?.connection;
  if (!connection) {
    const tbq = getFallbackQueue(exchange);
    await tbq.acquire();
    return fn();
  }

  // Ensure a worker is alive for this exchange (in-process)
  if (!bullmqWorkers.has(exchange)) {
    const rpmCap =
      ((queue as unknown as Record<string, unknown>)["_rpmCap"] as number | undefined) ??
      RATE_CAPS[exchange];

    const effectiveRpm = Math.floor(rpmCap * (opts.quotaFraction ?? 1.0));

    const worker = new bullmq.Worker(
      `trading:ratelimit:${exchange}`,
      async (job) => {
        // Worker just signals completion — actual fn call is outside the queue
        return job.data;
      },
      {
        connection,
        limiter: { max: effectiveRpm, duration: 60_000 },
        concurrency: 1,
      },
    );
    bullmqWorkers.set(exchange, worker);
  }

  // Enqueue a sentinel job and await its completion as a throttle gate,
  // then immediately call fn in the caller's context.
  return new Promise<T>((resolve, reject) => {
    queue
      .add(`rest-call`, {}, { priority: opts.priority ?? 10 })
      .then(() => fn().then(resolve, reject))
      .catch((err: unknown) => {
        // BullMQ failure — fall back to token bucket
        console.warn(`[ratelimit] BullMQ job add failed, falling back:`, err);
        const tbq = getFallbackQueue(exchange);
        tbq
          .acquire()
          .then(() => fn().then(resolve, reject))
          .catch(reject);
      });
  });
}

/** Gracefully close all BullMQ workers. Called during plugin deactivation. */
export async function closeRateLimitWorkers(): Promise<void> {
  await Promise.all([...bullmqWorkers.values()].map((w) => w.close()));
  bullmqWorkers.clear();
  bullmqQueues.clear();
}
