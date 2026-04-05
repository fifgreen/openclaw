import { z } from "zod";

export const SentimentSnapshotSchema = z.object({
  symbol: z.string(),
  fearGreedScore: z.number().min(0).max(1),
  fearGreedLabel: z.enum(["extreme_fear", "fear", "neutral", "greed", "extreme_greed"]),
  twitterScore: z.number().min(0).max(1),
  tweetVolume: z.number().int(),
  redditScore: z.number().min(0).max(1),
  redditPostVolume: z.number().int(),
  fundingBias: z.enum(["long", "short", "neutral"]),
  fundingRate: z.number(),
  compositeScore: z.number().min(0).max(1),
  lastUpdated: z.string(),
});

export type SentimentSnapshot = z.infer<typeof SentimentSnapshotSchema>;
