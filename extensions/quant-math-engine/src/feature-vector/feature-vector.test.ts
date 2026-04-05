import { describe, it, expect, beforeEach } from "vitest";
import type { OHLCVRow } from "../db/queries.js";
import { buildQuantFeatureVector } from "./builder.js";
import type { QuantConfig } from "./builder.js";
import { createFeatureVectorCache } from "./cache.js";

/** Generate synthetic OHLCV rows (deterministic random walk). */
function makeSyntheticOHLCV(count: number, seed = 100): OHLCVRow[] {
  const rows: OHLCVRow[] = [];
  let close = seed;
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
  equityCurve: [100, 105, 102, 108, 104, 107, 103, 109, 106, 110],
};

describe("buildQuantFeatureVector", () => {
  const ohlcv = makeSyntheticOHLCV(250);

  it("returns valid symbol + timestamp", () => {
    const vec = buildQuantFeatureVector("BTC/USDT", ohlcv, [], null, [], defaultCfg);
    expect(vec.symbol).toBe("BTC/USDT");
    expect(vec.timestamp).toBeGreaterThan(0);
  });

  it("computes non-null indicators when sufficient OHLCV provided", () => {
    const vec = buildQuantFeatureVector("BTC/USDT", ohlcv, [], null, [], defaultCfg);
    expect(vec.ema9).not.toBeNull();
    expect(vec.ema21).not.toBeNull();
    expect(vec.ema50).not.toBeNull();
    expect(vec.rsi).not.toBeNull();
    expect(vec.adx).not.toBeNull();
    expect(vec.atr).not.toBeNull();
    expect(vec.realizedVol).not.toBeNull();
  });

  it("returns null indicators when too few OHLCV rows", () => {
    const short = makeSyntheticOHLCV(5);
    const vec = buildQuantFeatureVector("BTC/USDT", short, [], null, [], defaultCfg);
    expect(vec.ema200).toBeNull();
    expect(vec.macdLine).toBeNull();
    expect(vec.bollingerUpper).toBeNull();
    expect(vec.realizedVol).toBeNull();
  });

  it("computes order flow when ticks provided", () => {
    const now = Date.now();
    const ticks = Array.from({ length: 20 }, (_, i) => ({
      quantity: 1,
      side: i % 3 === 0 ? ("sell" as const) : ("buy" as const),
      price: 100,
      timestamp: now - i * 1000,
    }));
    const vec = buildQuantFeatureVector("BTC/USDT", ohlcv, ticks, null, [], defaultCfg);
    expect(vec.cvd).not.toBeNull();
    expect(vec.tradeFlowBuyPct).not.toBeNull();
    expect(vec.tradeFlowBuyPct).toBeGreaterThan(0);
  });

  it("computes OB imbalance when snapshot provided", () => {
    const ob = {
      bids: [
        [99.5, 5],
        [99, 3],
      ] as [number, number][],
      asks: [
        [100.5, 2],
        [101, 1],
      ] as [number, number][],
    };
    const vec = buildQuantFeatureVector("BTC/USDT", ohlcv, [], ob, [], defaultCfg);
    expect(vec.obImbalance).not.toBeNull();
    expect(vec.obImbalance).toBeGreaterThan(0.5); // more bid qty
  });

  it("produces finite values where finite in schema", () => {
    const vec = buildQuantFeatureVector("BTC/USDT", ohlcv, [], null, [], defaultCfg);
    const numerics: (keyof typeof vec)[] = [
      "ema9",
      "ema21",
      "ema50",
      "rsi",
      "realizedVol",
      "currentDrawdown",
    ];
    for (const key of numerics) {
      const val = vec[key];
      if (val !== null) {
        expect(Number.isFinite(val as number), `${key} should be finite`).toBe(true);
      }
    }
  });

  it("defaults macroRegime to neutral", () => {
    const vec = buildQuantFeatureVector("BTC/USDT", ohlcv, [], null, [], defaultCfg);
    expect(vec.macroRegime).toBe("neutral");
  });
});

describe("createFeatureVectorCache", () => {
  it("returns null for missing key", () => {
    const cache = createFeatureVectorCache(1000);
    expect(cache.get("BTC/USDT")).toBeNull();
  });

  it("returns cached value within TTL", () => {
    const cache = createFeatureVectorCache(5000);
    const ohlcv = makeSyntheticOHLCV(250);
    const vec = buildQuantFeatureVector("ETH/USDT", ohlcv, [], null, [], defaultCfg);
    cache.set("ETH/USDT", vec);
    const result = cache.get("ETH/USDT");
    expect(result).not.toBeNull();
    expect(result?.symbol).toBe("ETH/USDT");
  });

  it("returns null after TTL expires", async () => {
    const cache = createFeatureVectorCache(10); // 10ms TTL
    const ohlcv = makeSyntheticOHLCV(250);
    const vec = buildQuantFeatureVector("SOL/USDT", ohlcv, [], null, [], defaultCfg);
    cache.set("SOL/USDT", vec);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(cache.get("SOL/USDT")).toBeNull();
  });

  it("invalidate removes entry", () => {
    const cache = createFeatureVectorCache(5000);
    const ohlcv = makeSyntheticOHLCV(250);
    const vec = buildQuantFeatureVector("BTC/USDT", ohlcv, [], null, [], defaultCfg);
    cache.set("BTC/USDT", vec);
    cache.invalidate("BTC/USDT");
    expect(cache.get("BTC/USDT")).toBeNull();
  });

  it("clear removes all entries", () => {
    const cache = createFeatureVectorCache(5000);
    const ohlcv = makeSyntheticOHLCV(250);

    for (const sym of ["BTC/USDT", "ETH/USDT", "SOL/USDT"]) {
      const vec = buildQuantFeatureVector(sym, ohlcv, [], null, [], defaultCfg);
      cache.set(sym, vec);
    }
    cache.clear();

    expect(cache.get("BTC/USDT")).toBeNull();
    expect(cache.get("ETH/USDT")).toBeNull();
  });
});
