import type { OHLCVRow } from "../db/queries.js";

/**
 * Average Directional Index (ADX).
 * Returns null when `ohlcv.length < period * 2`.
 * Uses Wilder smoothing for TR, +DM, -DM, then computes DX and smoothed ADX.
 * Result in [0, 100].
 */
export function computeADX(ohlcv: OHLCVRow[], period = 14): number | null {
  if (ohlcv.length < period * 2) return null;

  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < ohlcv.length; i++) {
    const curr = ohlcv[i]!;
    const prev = ohlcv[i - 1]!;

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;

    trueRanges.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  // Wilder smoothing seed
  let smoothedTR = trueRanges.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothedPlusDM = plusDMs.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothedMinusDM = minusDMs.slice(0, period).reduce((s, v) => s + v, 0);

  // Collect DX values
  const dxValues: number[] = [];

  const addDX = () => {
    if (smoothedTR === 0) return;
    const plusDI = (smoothedPlusDM / smoothedTR) * 100;
    const minusDI = (smoothedMinusDM / smoothedTR) * 100;
    const diDiff = Math.abs(plusDI - minusDI);
    const diSum = plusDI + minusDI;
    dxValues.push(diSum === 0 ? 0 : (diDiff / diSum) * 100);
  };

  addDX();

  for (let i = period; i < trueRanges.length; i++) {
    smoothedTR = smoothedTR - smoothedTR / period + trueRanges[i]!;
    smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDMs[i]!;
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDMs[i]!;
    addDX();
  }

  if (dxValues.length < period) return null;

  // ADX = SMA of DX values over the last `period` values
  const adx = dxValues.slice(-period).reduce((s, v) => s + v, 0) / period;
  return Math.max(0, Math.min(100, adx));
}
