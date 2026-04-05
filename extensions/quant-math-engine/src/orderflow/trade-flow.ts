import type { TickRecord } from "./cvd.js";

export interface TradeFlowResult {
  buyPct: number;
  totalVolume: number;
}

/**
 * Trade Flow — fraction of volume that is buyer-initiated.
 * Filters ticks to those within `windowMs` of `now`.
 * Returns `{ buyPct: 0.5, totalVolume: 0 }` when no ticks are in the window.
 */
export function computeTradeFlow(
  ticks: TickRecord[],
  windowMs: number,
  now: number,
): TradeFlowResult {
  const cutoff = now - windowMs;
  let buyVol = 0;
  let sellVol = 0;

  for (const tick of ticks) {
    if (tick.timestamp < cutoff) continue;
    if (tick.side === "buy") buyVol += tick.quantity;
    else sellVol += tick.quantity;
  }

  const totalVolume = buyVol + sellVol;
  if (totalVolume === 0) return { buyPct: 0.5, totalVolume: 0 };
  return { buyPct: buyVol / totalVolume, totalVolume };
}
