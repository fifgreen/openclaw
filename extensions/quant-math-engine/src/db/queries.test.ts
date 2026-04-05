import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryOHLCV } from "./queries.js";

function makeMockPool(rows: Record<string, unknown>[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as import("pg").Pool;
}

const RAW_ROWS = [
  {
    timestamp: 1700000000000,
    open: "83000",
    high: "84000",
    low: "82000",
    close: "83500",
    volume: "1000",
  },
  {
    timestamp: 1700000060000,
    open: "83500",
    high: "85000",
    low: "83200",
    close: "84800",
    volume: "1200",
  },
];

describe("queryOHLCV", () => {
  let pool: import("pg").Pool;

  beforeEach(() => {
    pool = makeMockPool(RAW_ROWS);
  });

  it("queries ohlcv_1m view for 1m timeframe", async () => {
    const rows = await queryOHLCV(pool, "BTC/USDT", "1m", 10);
    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(callArgs[0]).toContain("ohlcv_1m");
    expect(callArgs[1]).toEqual(["BTC/USDT", 10]);
  });

  it("queries ohlcv_5m view for 5m timeframe", async () => {
    await queryOHLCV(pool, "BTC/USDT", "5m", 50);
    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(callArgs[0]).toContain("ohlcv_5m");
  });

  it("queries ohlcv_1h view for 1h timeframe", async () => {
    await queryOHLCV(pool, "BTC/USDT", "1h", 168);
    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(callArgs[0]).toContain("ohlcv_1h");
  });

  it("parses string numbers to OHLCVRow correctly", async () => {
    const rows = await queryOHLCV(pool, "BTC/USDT", "1m", 10);
    expect(rows).toHaveLength(2);
    expect(typeof rows[0]!.open).toBe("number");
    expect(typeof rows[0]!.close).toBe("number");
  });

  it("filters rows with non-finite values", async () => {
    const corruptPool = makeMockPool([
      ...RAW_ROWS,
      { timestamp: "bad", open: "NaN", high: "Infinity", low: "0", close: "0", volume: "0" },
    ]);
    const rows = await queryOHLCV(corruptPool, "BTC/USDT", "1m", 10);
    expect(rows).toHaveLength(2); // corrupt row filtered
  });

  it("returns empty array when pool returns no rows", async () => {
    const emptyPool = makeMockPool([]);
    const rows = await queryOHLCV(emptyPool, "BTC/USDT", "1m", 10);
    expect(rows).toEqual([]);
  });

  it("applies ORDER BY and LIMIT in query", async () => {
    await queryOHLCV(pool, "BTC/USDT", "1m", 300);
    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(callArgs[0]).toContain("ORDER BY");
    expect(callArgs[0]).toContain("ASC");
    expect(callArgs[1][1]).toBe(300);
  });
});
