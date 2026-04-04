import { describe, it, expect, vi } from "vitest";
import { queryOHLCV } from "./queries.js";

// Mock the pg client module so tests run without a real database
vi.mock("./client.js", () => ({
  getPool: vi.fn(),
  closePool: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
}));

import { query } from "./client.js";

const mockedQuery = vi.mocked(query<Record<string, unknown>>);

function makeRow(ts: Date, i: number) {
  return {
    timestamp: ts,
    symbol: "BTC/USDT",
    open: String(65000 + i),
    high: String(65200 + i),
    low: String(64900 + i),
    close: String(65100 + i),
    volume: String(123.45 + i),
  };
}

describe("queryOHLCV", () => {
  it("uses ohlcv_1m view for timeframe=1m", async () => {
    const rows = [makeRow(new Date("2024-01-01T00:00:00Z"), 0)];
    mockedQuery.mockResolvedValueOnce(rows);

    await queryOHLCV("BTC/USDT", "1m", 10);

    expect(mockedQuery).toHaveBeenCalledWith(expect.stringContaining("ohlcv_1m"), ["BTC/USDT", 10]);
  });

  it("uses ohlcv_5m view for timeframe=5m", async () => {
    mockedQuery.mockResolvedValueOnce([makeRow(new Date(), 0)]);
    await queryOHLCV("BTC/USDT", "5m", 5);
    expect(mockedQuery).toHaveBeenCalledWith(expect.stringContaining("ohlcv_5m"), ["BTC/USDT", 5]);
  });

  it("uses ohlcv_1h view for timeframe=1h", async () => {
    mockedQuery.mockResolvedValueOnce([makeRow(new Date(), 0)]);
    await queryOHLCV("BTC/USDT", "1h", 24);
    expect(mockedQuery).toHaveBeenCalledWith(expect.stringContaining("ohlcv_1h"), ["BTC/USDT", 24]);
  });

  it("ORDER BY timestamp ASC is present in the query", async () => {
    mockedQuery.mockResolvedValueOnce([makeRow(new Date(), 0)]);
    await queryOHLCV("BTC/USDT", "1m", 10);
    expect(mockedQuery).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY timestamp ASC"),
      expect.any(Array),
    );
  });

  it("LIMIT is applied with the correct value", async () => {
    mockedQuery.mockResolvedValueOnce([makeRow(new Date(), 0)]);
    await queryOHLCV("ETH/USDT", "1h", 168);
    expect(mockedQuery).toHaveBeenCalledWith(expect.any(String), ["ETH/USDT", 168]);
  });

  it("maps rows to OHLCV type with numeric fields", async () => {
    const ts = new Date("2024-01-01T00:00:00Z");
    mockedQuery.mockResolvedValueOnce([makeRow(ts, 0)]);
    const result = await queryOHLCV("BTC/USDT", "1m", 10);
    expect(result[0]?.open).toBe(65000);
    expect(result[0]?.close).toBe(65100);
    expect(result[0]?.timestamp).toBe(ts.getTime());
    expect(result[0]?.timeframe).toBe("1m");
  });

  it("returns at most limit rows", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRow(new Date(Date.now() + i * 60000), i));
    mockedQuery.mockResolvedValueOnce(rows);
    const result = await queryOHLCV("BTC/USDT", "1m", 168);
    expect(result.length).toBeLessThanOrEqual(168);
    expect(result).toHaveLength(3);
  });
});
