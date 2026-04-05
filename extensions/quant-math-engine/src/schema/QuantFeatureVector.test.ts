import { describe, expect, it } from "vitest";
import { QuantFeatureVectorSchema } from "./QuantFeatureVector.js";

const validFullVector = {
  symbol: "BTC/USDT",
  timestamp: Date.now(),
  ema9: 83420.5,
  ema21: 82900.0,
  ema50: 81000.0,
  ema200: 75000.0,
  rsi: 62.4,
  macdLine: 44.2,
  macdSignal: 38.1,
  macdHistogram: 6.1,
  bollingerUpper: 85000.0,
  bollingerMiddle: 83000.0,
  bollingerLower: 81000.0,
  bollingerPosition: 0.71,
  stochRsi: 0.72,
  adx: 31.2,
  atr: 1245.0,
  obImbalance: 0.64,
  cvd: 186.5,
  tradeFlowBuyPct: 0.58,
  spreadZScore: -0.42,
  largeTradeCount: 3,
  largeTradeNetBias: 2.1,
  realizedVol: 0.48,
  hurstExponent: 0.63,
  regime: "trending" as const,
  btcEthCorrelation: 0.87,
  var95: 0.0497,
  var99: 0.0703,
  currentDrawdown: 0.018,
  maxDrawdown: 0.045,
  kellyFraction: 0.5,
  kellyPositionSize: 0.125,
  maxPositionSize: 0.045,
  macroRegime: "risk-on" as const,
};

describe("QuantFeatureVectorSchema", () => {
  it("parses a valid full vector", () => {
    const result = QuantFeatureVectorSchema.safeParse(validFullVector);
    expect(result.success).toBe(true);
  });

  it("parses a vector with all nullable fields set to null", () => {
    const partial = {
      symbol: "ETH/USDT",
      timestamp: Date.now(),
      ema9: null,
      ema21: null,
      ema50: null,
      ema200: null,
      rsi: null,
      macdLine: null,
      macdSignal: null,
      macdHistogram: null,
      bollingerUpper: null,
      bollingerMiddle: null,
      bollingerLower: null,
      bollingerPosition: null,
      stochRsi: null,
      adx: null,
      atr: null,
      obImbalance: null,
      cvd: null,
      tradeFlowBuyPct: null,
      spreadZScore: null,
      largeTradeCount: null,
      largeTradeNetBias: null,
      realizedVol: null,
      hurstExponent: null,
      regime: null,
      btcEthCorrelation: null,
      var95: null,
      var99: null,
      currentDrawdown: null,
      maxDrawdown: null,
      kellyFraction: null,
      kellyPositionSize: null,
      maxPositionSize: null,
      macroRegime: "neutral" as const,
    };
    const result = QuantFeatureVectorSchema.safeParse(partial);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid regime string", () => {
    const result = QuantFeatureVectorSchema.safeParse({
      ...validFullVector,
      regime: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid macroRegime string", () => {
    const result = QuantFeatureVectorSchema.safeParse({
      ...validFullVector,
      macroRegime: "very-bullish",
    });
    expect(result.success).toBe(false);
  });

  it("rejects Infinity in a numeric field", () => {
    const result = QuantFeatureVectorSchema.safeParse({
      ...validFullVector,
      rsi: Infinity,
    });
    expect(result.success).toBe(false);
  });

  it("rejects NaN in a numeric field", () => {
    const result = QuantFeatureVectorSchema.safeParse({
      ...validFullVector,
      adx: NaN,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { symbol: _s, ...withoutSymbol } = validFullVector;
    const result = QuantFeatureVectorSchema.safeParse(withoutSymbol);
    expect(result.success).toBe(false);
  });
});
