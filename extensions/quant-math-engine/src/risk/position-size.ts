export interface RiskConfig {
  maxKellyFraction: number; // e.g. 0.25
  varConfidence95: number; // z-score e.g. 1.645
  maxDrawdownHalt: number; // e.g. 0.20
  maxPositionRiskPct: number; // e.g. 0.02
}

export interface PositionSizeParams {
  kellyFraction: number;
  var95: number;
  accountEquity: number;
  currentDrawdown: number;
  cfg: RiskConfig;
}

/**
 * Computes the maximum safe position size in quote currency.
 * Applies three sequential guards:
 *   1. Drawdown halt: returns 0 if currentDrawdown > cfg.maxDrawdownHalt
 *   2. Kelly cap: kellyFraction × cfg.maxKellyFraction × accountEquity
 *   3. VaR cap: cfg.maxPositionRiskPct × accountEquity / var95
 * Result = min(kellyCap, varCap), minimum 0.
 */
export function computeMaxPositionSize(params: PositionSizeParams): number {
  const { kellyFraction, var95, accountEquity, currentDrawdown, cfg } = params;

  if (currentDrawdown > cfg.maxDrawdownHalt) return 0;

  const kellyCap = kellyFraction * cfg.maxKellyFraction * accountEquity;

  const varCap = var95 > 0 ? (cfg.maxPositionRiskPct * accountEquity) / var95 : accountEquity;

  return Math.max(0, Math.min(kellyCap, varCap));
}
