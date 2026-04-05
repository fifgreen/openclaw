import { describe, it, expect, vi } from "vitest";
import { scoreOutcome, queryFeedAccuracyStats } from "./AccuracyScorer.js";

function makePool(queryResults: Array<{ rows: unknown[] }>) {
  let callIndex = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const result = queryResults[callIndex] ?? { rows: [] };
      callIndex++;
      return Promise.resolve(result);
    }),
  } as unknown as import("pg").Pool;
}

describe("scoreOutcome", () => {
  it("inserts correctPredictions=1 when composite > 0.5 and outcome=profit", async () => {
    const pool = makePool([
      { rows: [{ composite_score: 0.7, recorded_at: "2025-01-15T08:55:00Z" }] }, // SELECT
      { rows: [] }, // INSERT
    ]);
    await scoreOutcome(pool, {
      tradeId: "trade-1",
      entryTimestamp: "2025-01-15T09:00:00Z",
      entrySymbol: "BTC",
      outcome: "profit",
    });
    const insertCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(insertCall[1]).toContain(1); // wasCorrect=1
  });

  it("inserts correctPredictions=0 for bearish composite with profit (wrong prediction)", async () => {
    const pool = makePool([
      { rows: [{ composite_score: 0.3, recorded_at: "2025-01-15T08:55:00Z" }] },
      { rows: [] },
    ]);
    await scoreOutcome(pool, {
      tradeId: "trade-2",
      entryTimestamp: "2025-01-15T09:00:00Z",
      entrySymbol: "ETH",
      outcome: "profit",
    });
    const insertCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(insertCall[1]).toContain(0); // wasCorrect=0
  });

  it("returns early (no insert) when no snapshot found", async () => {
    const pool = makePool([{ rows: [] }]);
    await scoreOutcome(pool, {
      tradeId: "trade-3",
      entryTimestamp: "2025-01-15T09:00:00Z",
      entrySymbol: "BTC",
      outcome: "profit",
    });
    expect(pool.query).toHaveBeenCalledTimes(1); // only SELECT, no INSERT
  });
});

describe("queryFeedAccuracyStats", () => {
  it("returns accuracy30d: null when sampleCount < 10", async () => {
    const pool = makePool([{ rows: [{ total: "8", correct: "6" }] }]);
    const result = await queryFeedAccuracyStats(pool, "sentiment_composite", 30);
    expect(result.accuracy30d).toBeNull();
    expect(result.sampleCount).toBe(8);
  });

  it("returns accuracy30d correctly when sampleCount >= 10", async () => {
    const pool = makePool([{ rows: [{ total: "10", correct: "7" }] }]);
    const result = await queryFeedAccuracyStats(pool, "sentiment_composite", 30);
    expect(result.accuracy30d).toBeCloseTo(0.7);
    expect(result.sampleCount).toBe(10);
  });

  it("returns accuracy30d: null and sampleCount 0 when no rows", async () => {
    const pool = makePool([{ rows: [{ total: null, correct: null }] }]);
    const result = await queryFeedAccuracyStats(pool, "sentiment_composite", 30);
    expect(result.accuracy30d).toBeNull();
    expect(result.sampleCount).toBe(0);
  });
});
