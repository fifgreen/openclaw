import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import type { Pool } from "pg";
import { queryFeedAccuracyStats } from "../health/AccuracyScorer.js";
import {
  FeedAccuracyReportSchema,
  type FeedAccuracyEntry,
  type FeedAccuracyReport,
} from "../schema/FeedAccuracy.js";

const KNOWN_FEEDS = ["fear_greed", "twitter", "reddit", "cryptopanic", "fred"] as const;

/**
 * Builds a per-feed accuracy report by reading MemDir health keys and DB accuracy stats.
 * Reads are parallelized per feed.
 */
export async function getFeedAccuracy(
  memDir: ReturnType<typeof createMemDir>,
  pool: Pool,
  periodDays = 30,
): Promise<FeedAccuracyReport> {
  const entries = await Promise.all(
    KNOWN_FEEDS.map(async (feedId): Promise<FeedAccuracyEntry> => {
      const [healthEntry, accuracyStats] = await Promise.all([
        memDir.get({ key: "sentiment_health", symbol: feedId }),
        queryFeedAccuracyStats(pool, feedId, periodDays),
      ]);

      const lastSuccessfulPoll = healthEntry?.value.lastSuccessfulPoll ?? new Date(0).toISOString();
      const isStale = healthEntry?.value.isStale ?? true;

      // Weight: linear normalization to [0.5, 1.5] once statistically significant
      const weight =
        accuracyStats.accuracy30d !== null && accuracyStats.sampleCount >= 10
          ? 0.5 + accuracyStats.accuracy30d
          : 1.0;

      return {
        feedId,
        lastSuccessfulPoll,
        isStale,
        accuracy30d: accuracyStats.accuracy30d,
        sampleCount: accuracyStats.sampleCount,
        weight,
      };
    }),
  );

  const report = FeedAccuracyReportSchema.parse({ feeds: entries });
  return report;
}

/**
 * Builds an OpenClaw tool descriptor for get_feed_accuracy.
 */
export function buildGetFeedAccuracyTool(memDir: ReturnType<typeof createMemDir>, pool: Pool) {
  return {
    name: "get_feed_accuracy",
    label: "Get Feed Accuracy",
    description:
      "Returns per-feed health and accuracy statistics for all 5 sentiment data feeds " +
      "(fear_greed, twitter, reddit, cryptopanic, fred). Includes last successful poll timestamp, " +
      "staleness flag, 30-day accuracy (null if fewer than 10 trades scored), and current weight.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    async execute(_params: Record<string, never>) {
      return getFeedAccuracy(memDir, pool);
    },
  };
}
