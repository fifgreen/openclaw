export interface DrawdownResult {
  /** Current drawdown from the most recent peak — fraction [0, 1]. */
  current: number;
  /** Maximum drawdown from any peak in the series — fraction [0, 1]. */
  max: number;
}

/**
 * Computes current and maximum drawdown from an equity curve.
 * Returns `{ current: 0, max: 0 }` when the curve has fewer than 2 points.
 */
export function computeDrawdown(equityCurve: number[]): DrawdownResult {
  if (equityCurve.length < 2) return { current: 0, max: 0 };

  let peak = equityCurve[0]!;
  let max = 0;

  for (const value of equityCurve) {
    if (value > peak) peak = value;
    const dd = peak > 0 ? (peak - value) / peak : 0;
    if (dd > max) max = dd;
  }

  const last = equityCurve[equityCurve.length - 1]!;
  const current = peak > 0 ? Math.max(0, (peak - last) / peak) : 0;

  return { current, max };
}
