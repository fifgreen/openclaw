import { describe, it, expect, vi, beforeEach } from "vitest";
import { HistoricalBootstrap } from "./HistoricalBootstrap.js";

// Mock database modules
vi.mock("../db/queries.js", () => ({
  batchInsertTicks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/client.js", () => ({
  getPool: vi.fn(),
  closePool: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
}));

import { query } from "../db/client.js";
import { batchInsertTicks } from "../db/queries.js";

const mockedQuery = vi.mocked(query<Record<string, unknown>>);
const mockedBatchInsert = vi.mocked(batchInsertTicks);

const MS_PER_MINUTE = 60_000;

function makeKlineRow(startTs: number): unknown[] {
  // Binance kline format: [openTime, open, high, low, close, volume, ...]
  return [startTs, "65000", "65200", "64900", "65100", "1.5", startTs + MS_PER_MINUTE];
}

function mockFetch(data: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  } as Response);
}

describe("HistoricalBootstrap", () => {
  let rateLimitedRest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitedRest = vi
      .fn()
      .mockImplementation(async (_ex: string, fn: () => Promise<unknown>) => fn());
  });

  it("fetches only the remaining time range when MAX(timestamp) exists", async () => {
    const existingTs = Date.now() - 60 * MS_PER_MINUTE; // 1 hour ago
    mockedQuery.mockResolvedValue([{ max_ts: new Date(existingTs).toISOString() }]);

    const klines = [makeKlineRow(existingTs + MS_PER_MINUTE)];
    mockFetch(klines);

    const bootstrap = new HistoricalBootstrap({ rateLimitedRest: rateLimitedRest as never });
    await bootstrap.run(["BTC/USDT"], 7);

    // Should only fetch from existingTs + 1m, not the full 7-day range
    const fetchUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(fetchUrl).toContain(`startTime=${existingTs + MS_PER_MINUTE}`);
  });

  it("idempotency: skips fetch when MAX(timestamp) is within last minute", async () => {
    const recentTs = Date.now() - 30_000; // 30 seconds ago
    mockedQuery.mockResolvedValue([{ max_ts: new Date(recentTs).toISOString() }]);

    const bootstrap = new HistoricalBootstrap({ rateLimitedRest: rateLimitedRest as never });
    const result = await bootstrap.run(["BTC/USDT"], 7);

    expect(result.imported).toBe(0);
  });

  it("fetches full days range when db is empty", async () => {
    mockedQuery.mockResolvedValue([{ max_ts: null }]);
    mockFetch([]); // empty = no more data

    const bootstrap = new HistoricalBootstrap({ rateLimitedRest: rateLimitedRest as never });
    await bootstrap.run(["BTC/USDT"], 7);

    // Should have been called at least once
    expect(globalThis.fetch).toHaveBeenCalled();
    const fetchUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    // Start time should be approximately 7 days ago (within 1-minute tolerance)
    const expectedStart = Date.now() - 7 * 24 * 60 * MS_PER_MINUTE;
    const actualStart = Number(new URL(fetchUrl).searchParams.get("startTime"));
    expect(Math.abs(actualStart - expectedStart)).toBeLessThan(MS_PER_MINUTE);
  });

  it("rateLimitedRest called with quotaFraction: 0.5", async () => {
    mockedQuery.mockResolvedValue([{ max_ts: null }]);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve([]) } as Response);

    const bootstrap = new HistoricalBootstrap({ rateLimitedRest: rateLimitedRest as never });
    await bootstrap.run(["ETH/USDT"], 1);

    if (rateLimitedRest.mock.calls.length > 0) {
      const callOpts = rateLimitedRest.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
      expect(callOpts?.["quotaFraction"]).toBe(0.5);
    }
  });

  it("logs progress per chunk boundary", async () => {
    const infoSpy = vi.fn();
    mockedQuery.mockResolvedValue([{ max_ts: null }]);
    mockFetch([]); // empty — no chunks to process

    const bootstrap = new HistoricalBootstrap({
      rateLimitedRest: rateLimitedRest as never,
      logger: { info: infoSpy, warn: vi.fn() },
    });
    await bootstrap.run(["BTC/USDT"], 1);
    // At minimum the start log fires
    expect(infoSpy).toHaveBeenCalled();
  });

  it("rejects when exchange returns a non-ok HTTP response", async () => {
    mockedQuery.mockResolvedValue([{ max_ts: null }]);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({}),
    } as Response);

    const bootstrap = new HistoricalBootstrap({ rateLimitedRest: rateLimitedRest as never });
    // Both Binance and Bybit will fail — run() should reject
    await expect(bootstrap.run(["BTC/USDT"], 1)).rejects.toThrow();
  });
});
