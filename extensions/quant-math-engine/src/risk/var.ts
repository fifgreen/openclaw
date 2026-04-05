/**
 * Parametric Value at Risk.
 * VaR = annualizedVol × sqrt(horizonDays / 252) × confidenceZScore
 * Returns the loss threshold as a positive decimal fraction (e.g. 0.042 = 4.2% of position value).
 * Result is clamped to [0, 1].
 */
export function parametricVaR(
  annualizedVol: number,
  confidenceZScore: number,
  horizonDays = 1,
): number {
  const var_ = annualizedVol * Math.sqrt(horizonDays / 252) * confidenceZScore;
  return Math.max(0, Math.min(1, var_));
}
