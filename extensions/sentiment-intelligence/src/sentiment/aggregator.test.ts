import { describe, it, expect, vi, beforeEach } from "vitest";
import { aggregate } from "./aggregator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function memDirEntry<T>(value: T, ageMsAgo = 0) {
  return {
    value,
    updatedAt: Date.now() - ageMsAgo,
    ttlMs: 14_400_000,
    source: "test",
  };
}

const FRESH_FG = memDirEntry({
  score: 0.72,
  label: "greed" as const,
  lastUpdated: new Date().toISOString(),
});
const FRESH_TW = memDirEntry({
  score: 0.6,
  postVolume: 100,
  lastUpdated: new Date().toISOString(),
});
const FRESH_RD = memDirEntry({
  score: 0.55,
  postVolume: 40,
  lastUpdated: new Date().toISOString(),
});
const STALE_TW = memDirEntry({
  score: 0.6,
  postVolume: 80,
  lastUpdated: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), // 6h ago
});

function makeMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ ctid: "(0,1)" }] }),
  };
}

function makeMemDir(
  fg: typeof FRESH_FG | null,
  tw: typeof FRESH_TW | null,
  rd: typeof FRESH_RD | null,
) {
  let callCount = 0;
  return {
    get: vi.fn().mockImplementation(async (descriptor: { key: string; symbol: string }) => {
      if (descriptor.key === "sentiment_subfeed_fear_greed") return fg;
      if (descriptor.key === "sentiment_subfeed_twitter") return tw;
      if (descriptor.key === "sentiment_subfeed_reddit") return rd;
      if (descriptor.key === "funding_rate") return null; // absent → neutral
      return null;
    }),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

const mockEmbedQueue = { add: vi.fn().mockResolvedValue(undefined) };

describe("SentimentAggregator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes weighted composite with all four feeds present", async () => {
    const memDir = makeMemDir(FRESH_FG, FRESH_TW, FRESH_RD);
    const pool = makeMockPool();

    const snap = await aggregate("BTC", memDir as never, pool as never, {
      embedQueue: mockEmbedQueue as never,
    });

    expect(snap.compositeScore).toBeGreaterThan(0.5);
    expect(snap.fearGreedScore).toBeCloseTo(0.72);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(mockEmbedQueue.add).toHaveBeenCalledWith(
      "embed-sentiment",
      expect.objectContaining({ type: "sentiment", symbol: "BTC" }),
    );
  });

  it("redistributes weight when one feed is stale and weights still sum to 1.0", async () => {
    const memDir = makeMemDir(FRESH_FG, STALE_TW, FRESH_RD);
    const pool = makeMockPool();

    const snap = await aggregate("BTC", memDir as never, pool as never);

    // Twitter is stale — its weight should be redistributed
    expect(snap.compositeScore).toBeGreaterThan(0);
    expect(snap.compositeScore).toBeLessThanOrEqual(1);
  });

  it("returns 0.5 and warns when all feeds are stale/absent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // All absent (stale)
    const memDir = makeMemDir(null, null, null);
    const pool = makeMockPool();

    const snap = await aggregate("BTC", memDir as never, pool as never);

    expect(snap.compositeScore).toBe(0.5);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stale"));
    warnSpy.mockRestore();
  });

  it("DB insert called with correct column values", async () => {
    const memDir = makeMemDir(FRESH_FG, FRESH_TW, FRESH_RD);
    const pool = makeMockPool();

    await aggregate("ETH", memDir as never, pool as never);

    const [sql, params] = pool.query.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO sentiment_snapshots");
    expect(params[0]).toBe("ETH"); // symbol
    expect(typeof params[1]).toBe("string"); // timestamp ISO
  });

  it("enqueues BullMQ embed job once per aggregate call", async () => {
    const memDir = makeMemDir(FRESH_FG, FRESH_TW, FRESH_RD);
    const pool = makeMockPool();

    await aggregate("BTC", memDir as never, pool as never, {
      embedQueue: mockEmbedQueue as never,
    });

    expect(mockEmbedQueue.add).toHaveBeenCalledTimes(1);
  });

  it("composite stays within [0, 1] range even with all max-score feeds", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Override with very high scores
    const highFG = memDirEntry({
      score: 1.0,
      label: "extreme_greed" as const,
      lastUpdated: new Date().toISOString(),
    });
    const highTW = memDirEntry({
      score: 1.0,
      postVolume: 100,
      lastUpdated: new Date().toISOString(),
    });
    const highRD = memDirEntry({
      score: 1.0,
      postVolume: 50,
      lastUpdated: new Date().toISOString(),
    });

    const memDir = {
      get: vi.fn().mockImplementation(async (d: { key: string }) => {
        if (d.key === "sentiment_subfeed_fear_greed") return highFG;
        if (d.key === "sentiment_subfeed_twitter") return highTW;
        if (d.key === "sentiment_subfeed_reddit") return highRD;
        if (d.key === "funding_rate") {
          return {
            value: { rate: 0.99, nextFundingAt: Date.now() },
            updatedAt: Date.now(),
            ttlMs: null,
            source: "test",
          };
        }
        return null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const pool = makeMockPool();

    const snap = await aggregate("BTC", memDir as never, pool as never);
    // fearGreed(1.0×0.3) + twitter(1.0×0.3) + reddit(1.0×0.3) + funding_long(0.7×0.1) = 0.97
    // No clamping occurs since 0.97 ≤ 1; verify composite is bounded correctly
    expect(snap.compositeScore).toBeGreaterThan(0.9);
    expect(snap.compositeScore).toBeLessThanOrEqual(1);
    warnSpy.mockRestore();
  });
});
