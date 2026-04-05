import type { OHLCVRow } from "../db/queries.js";

/**
 * Average True Range using Wilder smoothing.
 * Returns null when `ohlcv.length < period + 1` (need at least `period` TR values).
 */
export function computeATR(ohlcv: OHLCVRow[], period = 14): number | null {
  if (ohlcv.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const curr = ohlcv[i]!;
    const prev = ohlcv[i - 1]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  // Seed with SMA of first `period` TRs
  let atr = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]!) / period;
  }

  return atr;
}
