import { describe, it, expect, vi } from "vitest";
import {
  upsertMacroSnapshot,
  queryLatestMacroSnapshot,
  insertSentimentSnapshot,
  insertNewsEvent,
  queryNewsEvents,
  upsertFeedAccuracy,
  queryFeedAccuracy,
} from "./queries.js";

function makePool(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as import("pg").Pool;
}

describe("upsertMacroSnapshot", () => {
  it("sends INSERT ON CONFLICT DO UPDATE with correct params", async () => {
    const pool = makePool();
    await upsertMacroSnapshot(pool, {
      series_id: "DTWEXBGS",
      value: 102.5,
      unit: "index",
      effective_date: "2025-01-15",
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (series_id, effective_date)"),
      ["DTWEXBGS", 102.5, "index", "2025-01-15"],
    );
  });
});

describe("queryLatestMacroSnapshot", () => {
  it("uses DISTINCT ON (series_id) ordered by series_id, effective_date DESC", async () => {
    const mockRows = [
      { series_id: "DTWEXBGS", value: 102.5, unit: "index", effective_date: "2025-01-15" },
    ];
    const pool = makePool(mockRows);
    const result = await queryLatestMacroSnapshot(pool);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DISTINCT ON (series_id)"),
      undefined,
    );
    expect(result).toEqual(mockRows);
  });
});

describe("insertSentimentSnapshot", () => {
  it("inserts all columns in the correct order", async () => {
    const pool = makePool();
    await insertSentimentSnapshot(pool, {
      symbol: "BTC",
      fear_greed_score: 72,
      fear_greed_label: "greed",
      twitter_score: 0.65,
      tweet_volume: 12000,
      reddit_score: 0.55,
      reddit_post_volume: 800,
      funding_bias: "long",
      funding_rate: 0.0001,
      composite_score: 0.7,
      regime: "neutral",
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO sentiment_snapshots"),
      expect.arrayContaining(["BTC", 72, "greed"]),
    );
  });
});

describe("insertNewsEvent", () => {
  it("uses ON CONFLICT DO NOTHING for dedup", async () => {
    const pool = makePool();
    await insertNewsEvent(pool, {
      headline: "Bitcoin breaks $100k",
      source: "cryptopanic",
      symbols: ["BTC"],
      sentiment: "positive",
      relevance_score: 0.9,
      url: "https://example.com/1",
      published_at: "2025-01-15T09:00:00Z",
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT DO NOTHING"),
      expect.arrayContaining(["Bitcoin breaks $100k", "cryptopanic"]),
    );
  });
});

describe("queryNewsEvents", () => {
  it("filters by symbol using @> array contains", async () => {
    const pool = makePool([]);
    await queryNewsEvents(pool, { symbol: "BTC", limit: 10 });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("symbols @> ARRAY[$1]::text[]"),
      ["BTC", 10],
    );
  });

  it("includes sinceIso filter when provided", async () => {
    const pool = makePool([]);
    await queryNewsEvents(pool, { symbol: "ETH", sinceIso: "2025-01-01T00:00:00Z" });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("published_at >= $2"),
      expect.arrayContaining(["ETH", "2025-01-01T00:00:00Z"]),
    );
  });

  it("returns all events when no symbol given", async () => {
    const pool = makePool([]);
    await queryNewsEvents(pool, { limit: 5 });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY published_at DESC"),
      [5],
    );
  });
});

describe("queryFeedAccuracy", () => {
  it("filters by period_days and uses DISTINCT ON feed_name", async () => {
    const pool = makePool([]);
    await queryFeedAccuracy(pool, 7);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DISTINCT ON (feed_name)"),
      [7],
    );
  });
});
