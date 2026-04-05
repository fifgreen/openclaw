import { computeEMA } from "./ema.js";

export interface MACDResult {
  macdLine: number;
  signalLine: number;
  histogram: number;
}

/**
 * MACD (Moving Average Convergence/Divergence).
 * Returns null when `prices.length < slow + signal - 1`.
 * MACD line = EMA(fast) - EMA(slow); signal = EMA(MACD, signal); histogram = MACD - signal.
 */
export function computeMACD(prices: number[], fast = 12, slow = 26, signal = 9): MACDResult | null {
  // Need enough prices to compute the slow EMA, then signal periods of MACD values
  if (prices.length < slow + signal - 1) return null;

  // Compute MACD line values for each point starting from index slow-1
  const macdValues: number[] = [];
  for (let i = slow - 1; i < prices.length; i++) {
    const slice = prices.slice(0, i + 1);
    const fastEMA = computeEMA(slice, fast);
    const slowEMA = computeEMA(slice, slow);
    if (fastEMA === null || slowEMA === null) continue;
    macdValues.push(fastEMA - slowEMA);
  }

  if (macdValues.length < signal) return null;

  const signalLine = computeEMA(macdValues, signal);
  if (signalLine === null) return null;

  const macdLine = macdValues[macdValues.length - 1]!;
  return {
    macdLine,
    signalLine,
    histogram: macdLine - signalLine,
  };
}
