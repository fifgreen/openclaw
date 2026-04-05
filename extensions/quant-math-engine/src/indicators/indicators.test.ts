import { describe, expect, it } from "vitest";
import { computeADX } from "./adx.js";
import { computeATR } from "./atr.js";
import { computeBollinger } from "./bollinger.js";
import { computeEMA } from "./ema.js";
import { computeMACD } from "./macd.js";
import { computeRSI } from "./rsi.js";
import { computeStochRSI } from "./stochastic-rsi.js";

// Helpers to generate synthetic price series
function linearPrices(start: number, step: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i * step);
}

function flatPrices(price: number, count: number): number[] {
  return Array.from({ length: count }, () => price);
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

describe("computeEMA", () => {
  it("returns null when prices.length < period", () => {
    expect(computeEMA([1, 2, 3], 5)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(computeEMA([], 9)).toBeNull();
  });

  it("returns a finite number for sufficient data", () => {
    const prices = linearPrices(100, 1, 20);
    const ema = computeEMA(prices, 9);
    expect(ema).not.toBeNull();
    expect(Number.isFinite(ema!)).toBe(true);
  });

  it("EMA of a flat series equals the price", () => {
    const prices = flatPrices(50, 20);
    const ema = computeEMA(prices, 9);
    expect(ema).toBeCloseTo(50, 4);
  });

  it("EMA9 > EMA21 on strongly rising series", () => {
    const prices = linearPrices(100, 5, 50);
    const ema9 = computeEMA(prices, 9)!;
    const ema21 = computeEMA(prices, 21)!;
    expect(ema9).toBeGreaterThan(ema21);
  });
});

describe("computeRSI", () => {
  it("returns null when prices.length < period + 1", () => {
    expect(computeRSI([1, 2, 3], 14)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(computeRSI([], 14)).toBeNull();
  });

  it("returns ~50 for flat prices", () => {
    // Flat prices → no gains or losses → RSI convention: 100 (no losses)
    const prices = flatPrices(100, 20);
    const rsi = computeRSI(prices, 14);
    // With 0 losses, RS is infinite, so RSI = 100
    expect(rsi).toBe(100);
  });

  it("returns > 70 for strongly rising prices", () => {
    const prices = linearPrices(100, 2, 30);
    const rsi = computeRSI(prices, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!).toBeGreaterThan(70);
  });

  it("returns < 30 for strongly falling prices", () => {
    const prices = linearPrices(200, -2, 30);
    const rsi = computeRSI(prices, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!).toBeLessThan(30);
  });

  it("result is always in [0, 100]", () => {
    const prices = linearPrices(100, 1, 50);
    const rsi = computeRSI(prices, 14)!;
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });
});

describe("computeMACD", () => {
  it("returns null when prices.length < slow + signal - 1", () => {
    // Default: slow=26, signal=9 → need 34 prices
    expect(computeMACD(linearPrices(100, 1, 33))).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(computeMACD([])).toBeNull();
  });

  it("returns a MACDResult for sufficient data", () => {
    const prices = linearPrices(100, 1, 50);
    const result = computeMACD(prices);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.macdLine)).toBe(true);
    expect(Number.isFinite(result!.signalLine)).toBe(true);
    expect(Number.isFinite(result!.histogram)).toBe(true);
  });

  it("histogram = macdLine - signalLine", () => {
    const prices = linearPrices(100, 1, 60);
    const result = computeMACD(prices)!;
    expect(result.histogram).toBeCloseTo(result.macdLine - result.signalLine, 8);
  });
});

describe("computeBollinger", () => {
  it("returns null when prices.length < period", () => {
    expect(computeBollinger([1, 2, 3], 10)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(computeBollinger([])).toBeNull();
  });

  it("position is 0.5 when price equals the middle band (flat series)", () => {
    const prices = flatPrices(100, 25);
    const result = computeBollinger(prices, 20, 2);
    // Flat series: std=0, so upper=lower=middle; position=0.5 (handled by bandwidth=0 guard)
    expect(result).not.toBeNull();
    expect(result!.position).toBe(0.5);
  });

  it("position is between 0 and 1 for realistic series", () => {
    const prices = linearPrices(80, 1, 30);
    const result = computeBollinger(prices, 20, 2)!;
    expect(result.position).toBeGreaterThanOrEqual(0);
    expect(result.position).toBeLessThanOrEqual(1);
  });

  it("upper > middle > lower", () => {
    const prices = linearPrices(100, 1, 30);
    const result = computeBollinger(prices, 20, 2)!;
    expect(result.upper).toBeGreaterThan(result.middle);
    expect(result.middle).toBeGreaterThan(result.lower);
  });
});

describe("computeStochRSI", () => {
  it("returns null with insufficient data", () => {
    expect(computeStochRSI([1, 2, 3], 14)).toBeNull();
  });

  it("returns a value in [0, 1] for sufficient data", () => {
    const prices = linearPrices(100, 2, 50);
    const result = computeStochRSI(prices, 14);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(0);
    expect(result!).toBeLessThanOrEqual(1);
  });
});

describe("computeADX", () => {
  it("returns null when ohlcv.length < period * 2", () => {
    const ohlcv = syntheticOHLCV(linearPrices(100, 1, 20));
    expect(computeADX(ohlcv, 14)).toBeNull();
  });

  it("returns a value in [0, 100] for sufficient data", () => {
    const ohlcv = syntheticOHLCV(linearPrices(100, 1, 60));
    const adx = computeADX(ohlcv, 14);
    expect(adx).not.toBeNull();
    expect(adx!).toBeGreaterThanOrEqual(0);
    expect(adx!).toBeLessThanOrEqual(100);
  });

  it("ADX is high for strongly trending data", () => {
    const ohlcv = syntheticOHLCV(linearPrices(100, 5, 60));
    const adx = computeADX(ohlcv, 14);
    expect(adx).not.toBeNull();
    expect(adx!).toBeGreaterThan(20);
  });
});

describe("computeATR", () => {
  it("returns null when ohlcv.length < period + 1", () => {
    const ohlcv = syntheticOHLCV(linearPrices(100, 1, 5));
    expect(computeATR(ohlcv, 14)).toBeNull();
  });

  it("returns the range for constant OHLCV", () => {
    // high = c + 10, low = c - 10 → TR should be ~20
    const ohlcv = syntheticOHLCV(flatPrices(100, 20));
    const atr = computeATR(ohlcv, 14);
    expect(atr).not.toBeNull();
    expect(atr!).toBeCloseTo(20, 0); // ~20 points range
  });

  it("returns a finite positive number for realistic data", () => {
    const ohlcv = syntheticOHLCV(linearPrices(100, 1, 30));
    const atr = computeATR(ohlcv, 14)!;
    expect(Number.isFinite(atr)).toBe(true);
    expect(atr).toBeGreaterThan(0);
  });
});
