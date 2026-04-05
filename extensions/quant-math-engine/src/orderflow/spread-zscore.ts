/**
 * Spread Z-Score.
 * Returns how many standard deviations the current spread deviates from
 * the rolling mean of `spreadHistory`.
 * Returns null when `spreadHistory.length < 2` (insufficient history).
 * Returns 0 when std = 0 (constant spread history).
 */
export function computeSpreadZScore(currentSpread: number, spreadHistory: number[]): number | null {
  if (spreadHistory.length < 2) return null;

  const mean = spreadHistory.reduce((s, v) => s + v, 0) / spreadHistory.length;
  const variance = spreadHistory.reduce((s, v) => s + (v - mean) ** 2, 0) / spreadHistory.length;
  const std = Math.sqrt(variance);

  if (std === 0) return 0;
  return (currentSpread - mean) / std;
}
