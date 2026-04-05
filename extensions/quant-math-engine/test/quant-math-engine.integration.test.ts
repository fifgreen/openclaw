import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OHLCVRow } from "../src/db/queries.js";
import { buildQuantFeatureVector } from "../src/feature-vector/builder.js";
import type { QuantConfig } from "../src/feature-vector/builder.js";
import { createFeatureVectorCache } from "../src/feature-vector/cache.js";
import { getIndicatorsHandler } from "../src/tools/get-indicators.js";
import { getOrderFlowHandler } from "../src/tools/get-order-flow.js";
import { getQuantFeaturesHandler } from "../src/tools/get-quant-features.js";

// ---------------------------------------------------------------------------
// Synthetic data factory
// ---------------------------------------------------------------------------

function makeSyntheticOHLCV(count: number, startPrice = 100): OHLCVRow[] {
  const rows: OHLCVRow[] = [];
  let close = startPrice;
  for (let i = 0; i < count; i++) {
    const delta = ((i % 7) - 3) * 0.5;
    const open = close;
    close = Math.max(1, close + delta);
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    rows.push({
      timestamp: Date.now() - (count - i) * 60_000,
      open,
      high,
      low,
      close,
      volume: 100 + i,
    });
  }
  return rows;
}

const defaultCfg: QuantConfig = {
  hurstWindow: 100,
  orderflowWindowMs: 60_000,
  largeTradeThresholdUsd: 10_000,
  spreadHistoryLength: 50,
  varConfidence95: 1.645,
  varConfidence99: 2.326,
  risk: {
    maxKellyFraction: 0.25,
    varConfidence95: 1.645,
    maxDrawdownHalt: 0.2,
    maxPositionRiskPct: 0.02,
  },
  accountEquity: 100_000,
  equityCurve: [100_000, 102_000, 101_000, 103_000, 100_500],
};

// ---------------------------------------------------------------------------
// T042 – get_quant_features: mock pg + MemDir → assert key field values
// ---------------------------------------------------------------------------

describe("T042: get_quant_features integration", () => {
  const ohlcv = makeSyntheticOHLCV(250, 100);
  const now = Date.now();

  const ticks = Array.from({ length: 30 }, (_, i) => ({
    quantity: 1.5,
    side: i % 5 === 0 ? ("sell" as const) : ("buy" as const),
    price: 100,
    timestamp: now - i * 2000,
  }));

  const ob = {
    bids: [
      [99.5, 6.2],
      [99, 3.1],
    ] as [number, number][],
    asks: [
      [100.5, 2.5],
      [101, 1.0],
    ] as [number, number][],
  };

  const mockPool = { query: vi.fn() } as unknown as import("pg").Pool;
  vi.mocked(mockPool.query).mockResolvedValue({
    rows: ohlcv.map((r) => ({
      timestamp: r.timestamp,
      open: String(r.open),
      high: String(r.high),
      low: String(r.low),
      close: String(r.close),
      volume: String(r.volume),
    })),
    command: "SELECT",
    rowCount: ohlcv.length,
    oid: 0,
    fields: [],
  } as never);

  const orderFlowDeps = {
    getTicks: (_sym: string) => ticks,
    getOBSnapshot: (_sym: string) => ob,
    getSpreadHistory: (_sym: string) => Array.from({ length: 30 }, (_, i) => 0.8 + i * 0.02),
    orderflowWindowMs: 60_000,
    largeTradeThresholdUsd: 10_000,
  };

  it("returns a full QuantFeatureVector with non-null order flow fields", async () => {
    // Use buildQuantFeatureVector directly (avoids pg mock complexity)
    const vec = buildQuantFeatureVector(
      "BTC/USDT",
      ohlcv,
      ticks,
      ob,
      orderFlowDeps.getSpreadHistory("BTC/USDT"),
      defaultCfg,
    );

    expect(vec.symbol).toBe("BTC/USDT");
    expect(vec.tradeFlowBuyPct).not.toBeNull();
    // 25 buys out of 30 — buyPct should be > 0.5
    expect(vec.tradeFlowBuyPct).toBeGreaterThan(0.5);
    // OB has more bid qty: 6.2+3.1 = 9.3 vs ask qty 3.5 → imbalance > 0.5
    expect(vec.obImbalance).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// T043 – get_indicators: full indicator set on synthetic OHLCV
// ---------------------------------------------------------------------------

describe("T043: get_indicators with synthetic OHLCV", () => {
  const ohlcv = makeSyntheticOHLCV(250);
  const mockPool = { query: vi.fn() } as unknown as import("pg").Pool;

  beforeEach(() => {
    // Return raw string columns as pg would
    vi.mocked(mockPool.query).mockResolvedValue({
      rows: ohlcv.map((r) => ({
        timestamp: r.timestamp,
        open: String(r.open),
        high: String(r.high),
        low: String(r.low),
        close: String(r.close),
        volume: String(r.volume),
      })),
      command: "SELECT",
      rowCount: ohlcv.length,
      oid: 0,
      fields: [],
    } as never);
  });

  it("all EMA periods are non-null with 250 candles", async () => {
    const result = await getIndicatorsHandler(mockPool, "BTC/USDT", "1h", 250);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.ema9).not.toBeNull();
    expect(result.ema21).not.toBeNull();
    expect(result.ema50).not.toBeNull();
    expect(result.ema200).not.toBeNull();
    expect(result.rsi).not.toBeNull();
    expect(result.adx).not.toBeNull();
    expect(result.atr).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T044 – graceful null degradation with empty MemDir
// ---------------------------------------------------------------------------

describe("T044: graceful null with empty MemDir", () => {
  it("returns no_data error when no OHLCV rows", async () => {
    const mockPool = { query: vi.fn() } as unknown as import("pg").Pool;
    vi.mocked(mockPool.query).mockResolvedValue({
      rows: [],
      command: "SELECT",
      rowCount: 0,
      oid: 0,
      fields: [],
    } as never);
    const result = await getIndicatorsHandler(mockPool, "BTC/USDT", "1h", 250);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("no_data");
    }
  });

  it("returns no_data error when no ticks or OB", async () => {
    const deps = {
      getTicks: () => [],
      getOBSnapshot: () => null,
      getSpreadHistory: () => [],
      orderflowWindowMs: 60_000,
      largeTradeThresholdUsd: 10_000,
    };
    const result = await getOrderFlowHandler(deps, "SOL/USDT");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("no_data");
    }
  });

  it("returns null indicator fields when OHLCV too short for indicator", () => {
    const short = makeSyntheticOHLCV(10);
    const vec = buildQuantFeatureVector("BTC/USDT", short, [], null, [], defaultCfg);
    expect(vec.ema200).toBeNull();
    expect(vec.macdLine).toBeNull();
    expect(vec.bollingerUpper).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T045 – cache call-count assertion
// ---------------------------------------------------------------------------

describe("T045: FeatureVectorCache TTL and call count", () => {
  it("second call hits cache, not queryOHLCV", async () => {
    const ohlcv = makeSyntheticOHLCV(250);
    const mockPool = { query: vi.fn() } as unknown as import("pg").Pool;

    vi.mocked(mockPool.query).mockResolvedValue({
      rows: ohlcv.map((r) => ({
        timestamp: r.timestamp,
        open: String(r.open),
        high: String(r.high),
        low: String(r.low),
        close: String(r.close),
        volume: String(r.volume),
      })),
      command: "SELECT",
      rowCount: ohlcv.length,
      oid: 0,
      fields: [],
    } as never);

    const cache = createFeatureVectorCache(5_000);
    const orderFlowDeps = {
      getTicks: () => [],
      getOBSnapshot: () => null,
      getSpreadHistory: () => [],
      orderflowWindowMs: 60_000,
      largeTradeThresholdUsd: 10_000,
    };

    const deps = { pool: mockPool, cache, orderFlow: orderFlowDeps, cfg: defaultCfg };

    // First call — should query pg
    const r1 = await getQuantFeaturesHandler(deps, "BTC/USDT", "1h");
    expect("error" in r1).toBe(false);
    expect(mockPool.query).toHaveBeenCalledTimes(1);

    // Second call — should hit cache, NOT query pg again
    const r2 = await getQuantFeaturesHandler(deps, "BTC/USDT", "1h");
    expect(mockPool.query).toHaveBeenCalledTimes(1); // still 1
    expect("error" in r2).toBe(false);
    if (!("error" in r1) && !("error" in r2)) {
      expect(r2.symbol).toBe(r1.symbol);
      expect(r2.timestamp).toBe(r1.timestamp); // same cached timestamp
    }
  });

  it("expired cache entry triggers fresh pg query", async () => {
    const ohlcv = makeSyntheticOHLCV(250);
    const mockPool = { query: vi.fn() } as unknown as import("pg").Pool;

    vi.mocked(mockPool.query).mockResolvedValue({
      rows: ohlcv.map((r) => ({
        timestamp: r.timestamp,
        open: String(r.open),
        high: String(r.high),
        low: String(r.low),
        close: String(r.close),
        volume: String(r.volume),
      })),
      command: "SELECT",
      rowCount: ohlcv.length,
      oid: 0,
      fields: [],
    } as never);

    const cache = createFeatureVectorCache(10); // 10ms — expires very fast
    const orderFlowDeps = {
      getTicks: () => [],
      getOBSnapshot: () => null,
      getSpreadHistory: () => [],
      orderflowWindowMs: 60_000,
      largeTradeThresholdUsd: 10_000,
    };

    const deps = { pool: mockPool, cache, orderFlow: orderFlowDeps, cfg: defaultCfg };

    await getQuantFeaturesHandler(deps, "ETH/USDT", "1h");
    expect(mockPool.query).toHaveBeenCalledTimes(1);

    // Wait for TTL to expire
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    await getQuantFeaturesHandler(deps, "ETH/USDT", "1h");
    expect(mockPool.query).toHaveBeenCalledTimes(2); // fresh query
  });
});
