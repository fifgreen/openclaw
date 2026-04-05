import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import { Worker, type Queue } from "bullmq";
import type { Redis } from "ioredis";

// Scheduled polling intervals per feed (in ms)
const FEED_INTERVALS_MS: Record<string, number> = {
  fear_greed: 4 * 60 * 60 * 1_000, // 4h
  twitter: 4 * 60 * 60 * 1_000, // 4h
  reddit: 4 * 60 * 60 * 1_000, // 4h
  cryptopanic: 30 * 60 * 1_000, // 30 min
  fred: 24 * 60 * 60 * 1_000, // 24h
};

// Feed is stale if last poll is older than 2× its scheduled interval
const STALE_MULTIPLIER = 2;

export interface HealthMonitorOptions {
  queue: Queue;
  memDir: ReturnType<typeof createMemDir>;
  alertChannelId?: string;
  alert?: (opts: { channelId?: string; message: string }) => void;
}

const HEALTH_QUEUE = "sentiment:health";
const HEALTH_SCHEDULE = "*/5 * * * *"; // every 5 minutes

/**
 * Checks all registered feeds and updates their stale status in MemDir.
 * Emits log warnings on staleness transitions and fires alert callbacks.
 */
async function checkFeeds(
  memDir: ReturnType<typeof createMemDir>,
  alertChannelId: string | undefined,
  alert: ((opts: { channelId?: string; message: string }) => void) | undefined,
): Promise<void> {
  for (const [feedId, intervalMs] of Object.entries(FEED_INTERVALS_MS)) {
    const entry = await memDir.get({ key: "sentiment_health", symbol: feedId });
    const staleThresholdMs = intervalMs * STALE_MULTIPLIER;
    const now = Date.now();

    if (!entry) {
      // No health record — treat as immediately stale
      console.warn(`[HealthMonitor] Feed ${feedId} has no health record — treating as stale`);
      await memDir.set(
        { key: "sentiment_health", symbol: feedId },
        { lastSuccessfulPoll: new Date(0).toISOString(), isStale: true },
        { ttlMs: null, source: "HealthMonitor" },
      );
      alert?.({
        channelId: alertChannelId,
        message: `Feed ${feedId} has never reported a successful poll`,
      });
      continue;
    }

    const lastPollMs = new Date(entry.value.lastSuccessfulPoll).getTime();
    const wasStale = entry.value.isStale;
    const staleDurationMs = now - lastPollMs;
    const isStaleNow = staleDurationMs > staleThresholdMs;

    if (isStaleNow && !wasStale) {
      // Transition: fresh → stale
      const staleDurationMinutes = Math.round(staleDurationMs / 60_000);
      console.warn(
        `[HealthMonitor] Feed ${feedId} is stale: last polled ${staleDurationMinutes} minutes ago`,
      );
      alert?.({
        channelId: alertChannelId,
        message: `Feed ${feedId} is stale: last polled ${staleDurationMinutes} minutes ago`,
      });
    } else if (!isStaleNow && wasStale) {
      // Transition: stale → fresh (recovery)
      console.info(`[HealthMonitor] Feed ${feedId} recovered`);
    }

    if (isStaleNow !== wasStale) {
      await memDir.set(
        { key: "sentiment_health", symbol: feedId },
        { lastSuccessfulPoll: entry.value.lastSuccessfulPoll, isStale: isStaleNow },
        { ttlMs: null, source: "HealthMonitor" },
      );
    }
  }
}

/**
 * Starts the HealthMonitor BullMQ worker.
 * Registers a repeatable job and processes it every 5 minutes.
 */
export async function startHealthMonitor(opts: HealthMonitorOptions): Promise<Worker> {
  const { queue, memDir, alertChannelId, alert } = opts;

  // Register repeatable health check job
  await queue.add(
    "health-check",
    { type: "health" },
    { repeat: { pattern: HEALTH_SCHEDULE }, jobId: "health-check:repeat" },
  );

  const worker = new Worker(
    HEALTH_QUEUE,
    async (_job) => {
      await checkFeeds(memDir, alertChannelId, alert);
    },
    { connection: queue.opts.connection as Redis },
  );

  worker.on("failed", (job, err) => {
    console.warn(`[HealthMonitor] Health check job failed: ${err.message}`);
  });

  return worker;
}

// Export for direct testing
export { checkFeeds };
