/**
 * Rolling Pearson correlation between two series.
 * Returns null if either array has fewer than `period` elements.
 * Operates on the last `period` values of each array.
 * Result is clamped to [-1, 1].
 */
export function rollingCorrelation(a: number[], b: number[], period: number): number | null {
  if (a.length < period || b.length < period) return null;

  const aWindow = a.slice(-period);
  const bWindow = b.slice(-period);

  const meanA = aWindow.reduce((s, v) => s + v, 0) / period;
  const meanB = bWindow.reduce((s, v) => s + v, 0) / period;

  let cov = 0;
  let varA = 0;
  let varB = 0;

  for (let i = 0; i < period; i++) {
    const da = aWindow[i]! - meanA;
    const db = bWindow[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  const denom = Math.sqrt(varA * varB);
  if (denom === 0) return 0;

  return Math.max(-1, Math.min(1, cov / denom));
}
