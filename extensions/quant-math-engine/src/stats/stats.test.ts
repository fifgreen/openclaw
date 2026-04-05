import { describe, expect, it } from "vitest";
import { rollingCorrelation } from "./correlation.js";
import { computeHurst } from "./hurst.js";
import { detectRegime } from "./regime.js";
import { yangZhangVolatility } from "./volatility.js";

function linearPrices(start: number, step: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i * step);
}

function alternatingPrices(base: number, amplitude: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => base + (i % 2 === 0 ? amplitude : -amplitude));
}

function syntheticOHLCV(closes: number[]) {
  return closes.map((c) => ({
    timestamp: Date.now(),
    open: c - 5,
    high: c + 10,
    low: c - 10,
    close: c,
    volume: 100,
  }));
}

describe("yangZhangVolatility", () => {
  it("returns null when ohlcv.length < period + 1", () => {
    const ohlcv = syntheticOHLCV(linearPrices(100, 1, 30));
    expect(yangZhangVolatility(ohlcv, 30)).toBeNull();
  });

  it("returns a finite positive number for realistic data", () => {
    const closes = linearPrices(100, 1, 60);
    const ohlcv = closes.map((c, i) => ({
      timestamp: Date.now() + i * 60_000,
      open: c + (Math.random() - 0.5) * 2,
      high: c + 5,
      low: c - 5,
      close: c,
      volume: 100,
    }));
    const vol = yangZhangVolatility(ohlcv, 30);
    expect(vol).not.toBeNull();
    expect(Number.isFinite(vol!)).toBe(true);
    expect(vol!).toBeGreaterThan(0);
  });

  it("returns null for empty array", () => {
    expect(yangZhangVolatility([], 30)).toBeNull();
  });
});

describe("computeHurst", () => {
  it("returns null when prices.length < period + 1", () => {
    const prices = linearPrices(100, 1, 50);
    expect(computeHurst(prices, 100)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(computeHurst([], 100)).toBeNull();
  });

  it("returns H > 0.5 for strongly trending prices", () => {
    const prices = linearPrices(100, 2, 110); // consistent uptrend
    const h = computeHurst(prices, 100);
    expect(h).not.toBeNull();
    expect(h!).toBeGreaterThan(0.5);
  });

  it("returns H < 0.5 for mean-reverting (alternating) prices", () => {
    const prices = alternatingPrices(100, 5, 110);
    const h = computeHurst(prices, 100);
    expect(h).not.toBeNull();
    expect(h!).toBeLessThan(0.5);
  });

  it("result is in [0, 1]", () => {
    const prices = linearPrices(100, 1, 110);
    const h = computeHurst(prices, 100)!;
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(1);
  });
});

describe("rollingCorrelation", () => {
  it("returns null when either array has fewer than period elements", () => {
    expect(rollingCorrelation([1, 2, 3], [1, 2, 3, 4], 10)).toBeNull();
  });

  it("returns 1.0 for perfectly correlated series", () => {
    const a = linearPrices(100, 1, 20);
    const b = linearPrices(200, 2, 20);
    const corr = rollingCorrelation(a, b, 10);
    expect(corr).not.toBeNull();
    expect(corr!).toBeCloseTo(1.0, 4);
  });

  it("returns -1.0 for perfectly anti-correlated series", () => {
    const a = linearPrices(100, 1, 20);
    const b = linearPrices(200, -2, 20);
    const corr = rollingCorrelation(a, b, 10);
    expect(corr).not.toBeNull();
    expect(corr!).toBeCloseTo(-1.0, 4);
  });

  it("returns 0 for constant series (no variance)", () => {
    const a = Array.from({ length: 20 }, () => 5);
    const b = Array.from({ length: 20 }, () => 10);
    const corr = rollingCorrelation(a, b, 10);
    expect(corr).toBe(0);
  });

  it("result is always in [-1, 1]", () => {
    const a = linearPrices(100, 1, 20);
    const b = linearPrices(100, -1, 20);
    const corr = rollingCorrelation(a, b, 10)!;
    expect(corr).toBeGreaterThanOrEqual(-1);
    expect(corr).toBeLessThanOrEqual(1);
  });
});

describe("detectRegime", () => {
  it("returns 'trending' when hurst > 0.55", () => {
    expect(detectRegime(0.62)).toBe("trending");
    expect(detectRegime(0.56)).toBe("trending");
  });

  it("returns 'ranging' when hurst < 0.45", () => {
    expect(detectRegime(0.4)).toBe("ranging");
    expect(detectRegime(0.2)).toBe("ranging");
  });

  it("returns 'neutral' when hurst is between 0.45 and 0.55", () => {
    expect(detectRegime(0.5)).toBe("neutral");
    expect(detectRegime(0.45)).toBe("neutral");
    expect(detectRegime(0.55)).toBe("neutral");
  });

  it("returns 'neutral' when hurst is null", () => {
    expect(detectRegime(null)).toBe("neutral");
  });
});
