/**
 * Kelly Criterion — computes the optimal fraction of capital to bet.
 * Formula: f* = (winRate × avgWinPct - (1 - winRate) × avgLossPct) / avgWinPct
 * Returns 0 when the Kelly fraction is negative (edge is negative) or avgWinPct ≤ 0.
 * Result is clamped to [0, 1].
 */
export function kellyFraction(winRate: number, avgWinPct: number, avgLossPct: number): number {
  if (avgWinPct <= 0) return 0;
  const f = (winRate * avgWinPct - (1 - winRate) * avgLossPct) / avgWinPct;
  return Math.max(0, Math.min(1, f));
}
