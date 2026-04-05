/**
 * Exponential Moving Average.
 * Returns null when `prices.length < period`.
 * Seeds with SMA of the first `period` elements, then applies
 * the EMA multiplier k = 2 / (period + 1) for each subsequent price.
 */
export function computeEMA(prices: number[], period: number): number | null {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with SMA
  let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i]! * k + ema * (1 - k);
  }
  return ema;
}
