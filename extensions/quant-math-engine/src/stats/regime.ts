/**
 * Regime detection based on Hurst exponent.
 * - H > 0.55 → "trending" (persistent, momentum-driven)
 * - H < 0.45 → "ranging" (mean-reverting, oscillating)
 * - 0.45 ≤ H ≤ 0.55 → "neutral" (random walk)
 * - null → "neutral" (insufficient data)
 */
export function detectRegime(hurst: number | null): "trending" | "ranging" | "neutral" {
  if (hurst === null) return "neutral";
  if (hurst > 0.55) return "trending";
  if (hurst < 0.45) return "ranging";
  return "neutral";
}
