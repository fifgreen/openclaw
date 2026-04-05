export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  /** 0 = at lower band, 1 = at upper band; clamped to [0, 1] */
  position: number;
}

/**
 * Bollinger Bands.
 * Returns null when `prices.length < period`.
 * Middle = SMA(period); std = population std dev of last `period` prices.
 * Upper = middle + stdMultiplier × std; lower = middle - stdMultiplier × std.
 * Position = (last_price - lower) / (upper - lower) clamped to [0, 1].
 */
export function computeBollinger(
  prices: number[],
  period = 20,
  stdMultiplier = 2,
): BollingerResult | null {
  if (prices.length < period) return null;

  const window = prices.slice(-period);
  const middle = window.reduce((sum, p) => sum + p, 0) / period;
  const variance = window.reduce((sum, p) => sum + (p - middle) ** 2, 0) / period;
  const std = Math.sqrt(variance);

  const upper = middle + stdMultiplier * std;
  const lower = middle - stdMultiplier * std;
  const lastPrice = prices[prices.length - 1]!;

  const bandwidth = upper - lower;
  const position =
    bandwidth === 0 ? 0.5 : Math.max(0, Math.min(1, (lastPrice - lower) / bandwidth));

  return { upper, middle, lower, position };
}
