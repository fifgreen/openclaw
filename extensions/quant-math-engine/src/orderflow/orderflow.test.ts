import { describe, expect, it } from "vitest";
import { computeCVD } from "./cvd.js";
import { computeOBImbalance } from "./imbalance.js";
import { detectLargeTrades } from "./large-trades.js";
import { computeSpreadZScore } from "./spread-zscore.js";
import { computeTradeFlow } from "./trade-flow.js";

const NOW = 1700000300000; // reference "now"
const WINDOW_MS = 300_000; // 5 minutes

function makeTick(side: "buy" | "sell", qty: number, price = 83000, ageMs = 10_000) {
  return { quantity: qty, side, price, timestamp: NOW - ageMs };
}

describe("computeOBImbalance", () => {
  it("returns 0.5 when both sides are empty", () => {
    expect(computeOBImbalance([], [], 5)).toBe(0.5);
  });

  it("returns 1.0 when only bids exist", () => {
    const bids: [number, number][] = [[83000, 10]];
    expect(computeOBImbalance(bids, [], 5)).toBe(1);
  });

  it("returns 0.0 when only asks exist", () => {
    const asks: [number, number][] = [[83001, 10]];
    expect(computeOBImbalance([], asks, 5)).toBe(0);
  });

  it("returns 0.5 for equal bid and ask quantities", () => {
    const bids: [number, number][] = [[83000, 5]];
    const asks: [number, number][] = [[83001, 5]];
    expect(computeOBImbalance(bids, asks, 5)).toBe(0.5);
  });

  it("returns 0.62 for 62/38 bid/ask split", () => {
    const bids: [number, number][] = [[83000, 62]];
    const asks: [number, number][] = [[83001, 38]];
    expect(computeOBImbalance(bids, asks, 5)).toBeCloseTo(0.62, 4);
  });

  it("only uses top `depth` levels", () => {
    const bids: [number, number][] = [
      [83000, 10],
      [82990, 1000], // outside depth=1
    ];
    const asks: [number, number][] = [[83001, 10]];
    expect(computeOBImbalance(bids, asks, 1)).toBe(0.5); // 10/(10+10)
  });
});

describe("computeCVD", () => {
  it("returns positive CVD for all buy ticks", () => {
    const ticks = Array.from({ length: 60 }, () => makeTick("buy", 1));
    expect(computeCVD(ticks, WINDOW_MS, NOW)).toBe(60);
  });

  it("returns negative CVD for all sell ticks", () => {
    const ticks = Array.from({ length: 40 }, () => makeTick("sell", 1));
    expect(computeCVD(ticks, WINDOW_MS, NOW)).toBe(-40);
  });

  it("returns 0 for 60 buys and 60 sells", () => {
    const ticks = [
      ...Array.from({ length: 60 }, () => makeTick("buy", 1)),
      ...Array.from({ length: 60 }, () => makeTick("sell", 1)),
    ];
    expect(computeCVD(ticks, WINDOW_MS, NOW)).toBe(0);
  });

  it("excludes ticks outside the window", () => {
    const inWindow = makeTick("buy", 10, 83000, 60_000); // 1 min ago
    const outWindow = makeTick("buy", 10, 83000, WINDOW_MS + 1_000); // outside
    expect(computeCVD([inWindow, outWindow], WINDOW_MS, NOW)).toBe(10);
  });
});

describe("computeSpreadZScore", () => {
  it("returns null with fewer than 2 history entries", () => {
    expect(computeSpreadZScore(3.0, [])).toBeNull();
    expect(computeSpreadZScore(3.0, [3.0])).toBeNull();
  });

  it("returns 0 for constant spread history", () => {
    const history = [3.0, 3.0, 3.0, 3.0, 3.0];
    expect(computeSpreadZScore(3.0, history)).toBe(0);
  });

  it("returns a positive Z-score for spread above mean", () => {
    const history = [2.0, 2.1, 1.9, 2.0, 2.0];
    const z = computeSpreadZScore(4.0, history)!;
    expect(z).toBeGreaterThan(1);
  });

  it("returns a negative Z-score for spread below mean", () => {
    const history = [3.0, 3.1, 2.9, 3.0, 3.0];
    const z = computeSpreadZScore(1.0, history)!;
    expect(z).toBeLessThan(0);
  });
});

describe("computeTradeFlow", () => {
  it("returns { buyPct: 0.5, totalVolume: 0 } when no ticks in window", () => {
    const stale = makeTick("buy", 10, 83000, WINDOW_MS + 1_000);
    const result = computeTradeFlow([stale], WINDOW_MS, NOW);
    expect(result.buyPct).toBe(0.5);
    expect(result.totalVolume).toBe(0);
  });

  it("returns buyPct ≈ 0.60 for 60/40 buy/sell split", () => {
    const ticks = [
      ...Array.from({ length: 60 }, () => makeTick("buy", 1)),
      ...Array.from({ length: 40 }, () => makeTick("sell", 1)),
    ];
    const result = computeTradeFlow(ticks, WINDOW_MS, NOW);
    expect(result.buyPct).toBeCloseTo(0.6, 4);
    expect(result.totalVolume).toBe(100);
  });
});

describe("detectLargeTrades", () => {
  it("returns count=0 when no trades exceed threshold", () => {
    const ticks = [makeTick("buy", 1, 83000)]; // notional = $83K < $500K
    const result = detectLargeTrades(ticks, 500_000, WINDOW_MS, NOW);
    expect(result.count).toBe(0);
    expect(result.netBias).toBe(0);
  });

  it("counts and tracks large buy trades", () => {
    const largeBuys = Array.from({ length: 3 }, () => makeTick("buy", 7, 83000)); // 7×83000 = $581K
    const smallBuys = Array.from({ length: 5 }, () => makeTick("buy", 1, 83000));
    const result = detectLargeTrades([...largeBuys, ...smallBuys], 500_000, WINDOW_MS, NOW);
    expect(result.count).toBe(3);
    expect(result.netBias).toBeGreaterThan(0);
  });

  it("net bias is negative for large sell pressure", () => {
    const largeSells = Array.from({ length: 2 }, () => makeTick("sell", 7, 83000));
    const result = detectLargeTrades(largeSells, 500_000, WINDOW_MS, NOW);
    expect(result.netBias).toBeLessThan(0);
  });

  it("excludes ticks outside the time window", () => {
    const stale = { ...makeTick("buy", 7, 83000), timestamp: NOW - WINDOW_MS - 1_000 };
    const result = detectLargeTrades([stale], 500_000, WINDOW_MS, NOW);
    expect(result.count).toBe(0);
  });
});
