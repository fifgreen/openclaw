import type { OHLCVRow } from "../db/queries.js";

/**
 * Yang-Zhang realized volatility estimator.
 * More accurate than close-to-close because it uses OHLC data.
 *
 * σ² = σ_o² + k×σ_c² + (1-k)×σ_rs²
 * where:
 *   σ_o  = overnight (open-to-prev-close) return variance
 *   σ_c  = open-to-close return variance
 *   σ_rs = Rogers-Satchell variance
 *   k    = 0.34 / (1.34 + (n+1)/(n-1))
 *
 * Result is annualized (multiplied by sqrt(252) for daily data).
 * Returns null when `ohlcv.length < period + 1`.
 */
export function yangZhangVolatility(ohlcv: OHLCVRow[], period = 30): number | null {
  if (ohlcv.length < period + 1) return null;

  const window = ohlcv.slice(-period - 1);
  const n = period;
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));

  let sumO2 = 0; // overnight return variance components
  let sumC2 = 0; // open-to-close return variance components
  let sumRS = 0; // Rogers-Satchell components

  for (let i = 1; i <= period; i++) {
    const prev = window[i - 1]!;
    const curr = window[i]!;

    const logO = Math.log(curr.open / prev.close); // overnight return
    const logC = Math.log(curr.close / curr.open); // open-to-close
    const logH = Math.log(curr.high / curr.open);
    const logL = Math.log(curr.low / curr.open);

    sumO2 += logO * logO;
    sumC2 += logC * logC;
    sumRS += logH * (logH - logC) + logL * (logL - logC);
  }

  const sigmaO2 = sumO2 / (n - 1);
  const sigmaC2 = sumC2 / (n - 1);
  const sigmaRS = sumRS / n;

  const variance = sigmaO2 + k * sigmaC2 + (1 - k) * sigmaRS;
  if (variance < 0) return null; // numerical edge case

  // Annualize: multiply daily vol by sqrt(252)
  return Math.sqrt(variance) * Math.sqrt(252);
}
