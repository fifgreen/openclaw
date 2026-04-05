import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import type { SentimentSnapshot } from "../schema/SentimentSnapshot.js";
import { deriveFundingBias } from "./funding-bias.js";

const STALE_THRESHOLD_MS = 5 * 60 * 60 * 1000; // 5 h

interface FeedWeight {
  key: "fearGreed" | "twitter" | "reddit" | "funding";
  weight: number;
}

const DEFAULT_FEED_WEIGHTS: FeedWeight[] = [
  { key: "fearGreed", weight: 0.3 },
  { key: "twitter", weight: 0.3 },
  { key: "reddit", weight: 0.3 },
  { key: "funding", weight: 0.1 },
];

interface SubfeedValues {
  fearGreedScore: number;
  fearGreedLabel: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
  twitterScore: number;
  tweetVolume: number;
  redditScore: number;
  redditPostVolume: number;
  fundingBias: "long" | "short" | "neutral";
  fundingRate: number;
}

function clamp(value: number, label: string): number {
  if (value < 0 || value > 1) {
    console.warn(`[SentimentAggregator] ${label} = ${value} out of [0,1] — clamping`);
    return Math.max(0, Math.min(1, value));
  }
  return value;
}

function isStale(lastUpdated: string): boolean {
  return Date.now() - new Date(lastUpdated).getTime() > STALE_THRESHOLD_MS;
}

function redistributeWeights(
  weights: FeedWeight[],
  staleKeys: Set<"fearGreed" | "twitter" | "reddit" | "funding">,
): FeedWeight[] {
  const active = weights.filter((w) => !staleKeys.has(w.key));
  if (active.length === 0) return weights; // all stale — keep original (will return 0.5)
  const totalActive = active.reduce((s, w) => s + w.weight, 0);
  return weights.map((w) => ({
    key: w.key,
    weight: staleKeys.has(w.key) ? 0 : w.weight / totalActive,
  }));
}

/** Funding bias score: long → 0.7, neutral → 0.5, short → 0.3. */
function fundingBiasScore(bias: "long" | "short" | "neutral"): number {
  if (bias === "long") return 0.7;
  if (bias === "short") return 0.3;
  return 0.5;
}

export interface AggregatorOptions {
  embedQueue?: Queue;
  compositeWeights?: Partial<Record<"fearGreed" | "twitter" | "reddit" | "funding", number>>;
}

/**
 * Reads all sub-feed scores from MemDir, computes a weighted composite
 * SentimentSnapshot, writes it to MemDir and TimescaleDB, and enqueues
 * an embedding job.
 */
export async function aggregate(
  symbol: string,
  memDir: ReturnType<typeof createMemDir>,
  pool: Pool,
  opts: AggregatorOptions = {},
): Promise<SentimentSnapshot> {
  // Read sub-feeds
  const [fgEntry, twEntry, rdEntry] = await Promise.all([
    memDir.get({ key: "sentiment_subfeed_fear_greed", symbol: "*" }),
    memDir.get({ key: "sentiment_subfeed_twitter", symbol }),
    memDir.get({ key: "sentiment_subfeed_reddit", symbol }),
  ]);

  const fundingResult = await deriveFundingBias(symbol, memDir);

  const staleKeys = new Set<"fearGreed" | "twitter" | "reddit" | "funding">();

  const fgScore = fgEntry ? fgEntry.value.score : 0.5;
  const fgLabel = fgEntry ? fgEntry.value.label : ("neutral" as const);
  if (!fgEntry || isStale(fgEntry.value.lastUpdated)) staleKeys.add("fearGreed");

  const twScore = twEntry ? twEntry.value.score : 0.5;
  const twVolume = twEntry ? twEntry.value.postVolume : 0;
  if (!twEntry || isStale(twEntry.value.lastUpdated)) staleKeys.add("twitter");

  const rdScore = rdEntry ? rdEntry.value.score : 0.5;
  const rdVolume = rdEntry ? rdEntry.value.postVolume : 0;
  if (!rdEntry || isStale(rdEntry.value.lastUpdated)) staleKeys.add("reddit");

  const fdScore = fundingBiasScore(fundingResult.bias);
  if (fundingResult.rate === 0 && fundingResult.bias === "neutral") staleKeys.add("funding");

  // Build feed value map for composite calculation
  const values: Record<"fearGreed" | "twitter" | "reddit" | "funding", number> = {
    fearGreed: fgScore,
    twitter: twScore,
    reddit: rdScore,
    funding: fdScore,
  };

  // Apply custom weight overrides
  const baseWeights: FeedWeight[] = DEFAULT_FEED_WEIGHTS.map((w) => ({
    key: w.key,
    weight: opts.compositeWeights?.[w.key] ?? w.weight,
  }));
  const normalizedTotal = baseWeights.reduce((s, w) => s + w.weight, 0);
  const normalizedWeights = baseWeights.map((w) => ({
    ...w,
    weight: w.weight / normalizedTotal,
  }));

  let effectiveWeights: FeedWeight[];
  let compositeScore: number;

  if (staleKeys.size === normalizedWeights.length) {
    // All stale — return neutral 0.5
    console.warn(`[SentimentAggregator] All feeds stale for ${symbol} — returning 0.5`);
    compositeScore = 0.5;
    effectiveWeights = normalizedWeights;
  } else {
    effectiveWeights = redistributeWeights(normalizedWeights, staleKeys);
    const raw = effectiveWeights.reduce((sum, w) => sum + w.weight * values[w.key], 0);
    compositeScore = clamp(raw, "compositeScore");
  }

  const snapshot: SentimentSnapshot = {
    symbol,
    fearGreedScore: fgScore,
    fearGreedLabel: fgLabel,
    twitterScore: twScore,
    tweetVolume: twVolume,
    redditScore: rdScore,
    redditPostVolume: rdVolume,
    fundingBias: fundingResult.bias,
    fundingRate: fundingResult.rate,
    compositeScore,
    lastUpdated: new Date().toISOString(),
  };

  // Write composite to MemDir
  await memDir.set({ key: "sentiment_composite", symbol }, snapshot, {
    ttlMs: 3_600_000,
    source: "SentimentAggregator",
  });

  // Persist to TimescaleDB
  try {
    const insertResult = await pool.query(
      `INSERT INTO sentiment_snapshots
         (symbol, timestamp, fear_greed_score, fear_greed_label, twitter_score, tweet_volume,
          reddit_score, reddit_post_volume, funding_bias, funding_rate, composite_score, regime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ctid`,
      [
        symbol,
        snapshot.lastUpdated,
        snapshot.fearGreedScore,
        snapshot.fearGreedLabel,
        snapshot.twitterScore,
        snapshot.tweetVolume,
        snapshot.redditScore,
        snapshot.redditPostVolume,
        snapshot.fundingBias,
        snapshot.fundingRate,
        snapshot.compositeScore,
        null, // regime populated by macro layer
      ],
    );

    // Enqueue embedding job
    if (opts.embedQueue && insertResult.rowCount && insertResult.rowCount > 0) {
      await opts.embedQueue.add("embed-sentiment", {
        type: "sentiment",
        symbol,
        timestamp: snapshot.lastUpdated,
        payload: snapshot,
      });
    }
  } catch (err: unknown) {
    console.error("[SentimentAggregator] DB insert failed:", (err as Error).message);
  }

  return snapshot;
}

/**
 * Computes and writes a global composite snapshot to MemDir.
 * Uses Fear & Greed as the global base, averaged with the mean funding bias
 * across provided per-symbol snapshots.
 */
export async function aggregateGlobal(
  snapshots: SentimentSnapshot[],
  fearGreedScore: number,
  memDir: ReturnType<typeof createMemDir>,
): Promise<void> {
  if (snapshots.length === 0) return;

  const avgFunding =
    snapshots.reduce((s, snap) => {
      return s + fundingBiasScore(snap.fundingBias);
    }, 0) / snapshots.length;

  const compositeScore = clamp((fearGreedScore + avgFunding) / 2, "globalComposite");

  const globalSnapshot: SentimentSnapshot = {
    symbol: "global",
    fearGreedScore,
    fearGreedLabel: snapshots[0]!.fearGreedLabel,
    twitterScore: snapshots.reduce((s, snap) => s + snap.twitterScore, 0) / snapshots.length,
    tweetVolume: snapshots.reduce((s, snap) => s + snap.tweetVolume, 0),
    redditScore: snapshots.reduce((s, snap) => s + snap.redditScore, 0) / snapshots.length,
    redditPostVolume: snapshots.reduce((s, snap) => s + snap.redditPostVolume, 0),
    fundingBias: "neutral",
    fundingRate: 0,
    compositeScore,
    lastUpdated: new Date().toISOString(),
  };

  await memDir.set({ key: "sentiment_composite", symbol: "global" }, globalSnapshot, {
    ttlMs: 3_600_000,
    source: "SentimentAggregator",
  });
}
