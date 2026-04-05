import { computeRSI } from "./rsi.js";

/**
 * Stochastic RSI.
 * First computes the RSI series, then applies Stochastic normalization
 * over the last `period` RSI values: (RSI - minRSI) / (maxRSI - minRSI).
 * Returns null if insufficient data for both RSI and Stochastic window.
 * Result is in [0, 1].
 */
export function computeStochRSI(prices: number[], period = 14): number | null {
  // Need enough prices to build a RSI series of at least `period` values.
  // RSI needs period+1 prices per value, so we need prices.length >= 2*period+1
  if (prices.length < 2 * period + 1) return null;

  // Build RSI series: compute RSI at each tail window
  const rsiSeries: number[] = [];
  for (let i = period; i <= prices.length - 1; i++) {
    const slice = prices.slice(0, i + 1);
    const rsi = computeRSI(slice, period);
    if (rsi !== null) rsiSeries.push(rsi);
  }

  if (rsiSeries.length < period) return null;

  const window = rsiSeries.slice(-period);
  const minRSI = Math.min(...window);
  const maxRSI = Math.max(...window);
  const lastRSI = window[window.length - 1]!;

  if (maxRSI === minRSI) return 0.5;
  return Math.max(0, Math.min(1, (lastRSI - minRSI) / (maxRSI - minRSI)));
}
