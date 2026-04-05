import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { Pool } from "pg";
import { queryFeedAccuracyStats } from "../health/AccuracyScorer.js";
import {
  FeedAccuracyReportSchema,
  type FeedAccuracyEntry,
  type FeedAccuracyReport,
} from "../schema/FeedAccuracy.js";

const KNOWN_FEEDS = ["fear_greed", "twitter", "reddit", "cryptopanic", "fred"] as const;

/**
 * Builds a per-feed health report and composite accuracy stats.
 * Individual feeds report health only; accuracy is tracked at the composite level.
 */
export async function getFeedAccuracy(
  memDir: ReturnType<typeof createMemDir>,
  pool: Pool,
  periodDays = 30,
): Promise<FeedAccuracyReport> {
  // Query composite accuracy once (shared across all feeds)
  const compositeAccuracy = await queryFeedAccuracyStats(pool, "sentiment_composite", periodDays);

  const entries = await Promise.all(
    KNOWN_FEEDS.map(async (feedId): Promise<FeedAccuracyEntry> => {
      const healthEntry = await memDir.get({ key: "sentiment_health", symbol: feedId });

      const lastSuccessfulPoll = healthEntry?.value.lastSuccessfulPoll ?? new Date(0).toISOString();
      const isStale = healthEntry?.value.isStale ?? true;

      // Weight: linear normalization to [0.5, 1.5] based on composite accuracy
      const weight =
        compositeAccuracy.accuracy30d !== null && compositeAccuracy.sampleCount >= 10
          ? 0.5 + compositeAccuracy.accuracy30d
          : 1.0;

      return {
        feedId,
        lastSuccessfulPoll,
        isStale,
        accuracy30d: compositeAccuracy.accuracy30d,
        sampleCount: compositeAccuracy.sampleCount,
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
      "Returns health and accuracy statistics for all 5 sentiment data feeds " +
      "(fear_greed, twitter, reddit, cryptopanic, fred). Each feed reports per-feed health " +
      "(last poll timestamp, staleness), and shares the composite accuracy metric " +
      "(30-day accuracy, null if fewer than 10 trades scored, and current weight).",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    async execute(_toolCallId: string, _params: Record<string, unknown>) {
      const data = await getFeedAccuracy(memDir, pool);
      return jsonResult(data);
    },
  };
}
