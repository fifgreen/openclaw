import { describe, it, expect } from "vitest";
import { SentimentSnapshotSchema } from "./SentimentSnapshot.js";

const valid = {
  symbol: "BTC",
  fearGreedScore: 0.72,
  fearGreedLabel: "greed",
  twitterScore: 0.6,
  tweetVolume: 1200,
  redditScore: 0.55,
  redditPostVolume: 340,
  fundingBias: "long",
  fundingRate: 0.00012,
  compositeScore: 0.62,
  lastUpdated: "2026-04-05T12:00:00.000Z",
};

describe("SentimentSnapshotSchema", () => {
  it("parses a valid snapshot", () => {
    const result = SentimentSnapshotSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects missing required field", () => {
    const { symbol: _omit, ...noSymbol } = valid;
    const result = SentimentSnapshotSchema.safeParse(noSymbol);
    expect(result.success).toBe(false);
  });

  it("rejects string instead of number for fearGreedScore", () => {
    const result = SentimentSnapshotSchema.safeParse({ ...valid, fearGreedScore: "0.72" });
    expect(result.success).toBe(false);
  });

  it("rejects score out of [0,1]", () => {
    const result = SentimentSnapshotSchema.safeParse({ ...valid, compositeScore: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects invalid fearGreedLabel", () => {
    const result = SentimentSnapshotSchema.safeParse({ ...valid, fearGreedLabel: "panic" });
    expect(result.success).toBe(false);
  });
});
