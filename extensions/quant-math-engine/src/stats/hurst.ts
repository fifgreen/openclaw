/**
 * Hurst Exponent using Rescaled Range (R/S) analysis.
 * H > 0.55 → trending (persistent), H < 0.45 → mean-reverting (anti-persistent)
 * H ≈ 0.5 → random walk.
 *
 * Computed on the last `period` log-returns.
 * Returns null when `prices.length < period + 1`.
 * Result is clamped to [0, 1].
 */
export function computeHurst(prices: number[], period = 100): number | null {
  if (prices.length < period + 1) return null;

  const window = prices.slice(-(period + 1));

  // Compute log-returns
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1]! <= 0) return null; // guard against zero/negative prices
    returns.push(Math.log(window[i]! / window[i - 1]!));
  }

  const n = returns.length;
  if (n < 2) return null;

  const mean = returns.reduce((s, v) => s + v, 0) / n;

  // Mean-adjusted cumulative sum
  const cumDev: number[] = [];
  let cum = 0;
  for (const r of returns) {
    cum += r - mean;
    cumDev.push(cum);
  }

  const rangeR = Math.max(...cumDev) - Math.min(...cumDev);
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdS = Math.sqrt(variance);

  if (stdS === 0 || rangeR === 0) return 0.5;

  const rs = rangeR / stdS;
  const hurst = Math.log(rs) / Math.log(n);

  return Math.max(0, Math.min(1, hurst));
}
