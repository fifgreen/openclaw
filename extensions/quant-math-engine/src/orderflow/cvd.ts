export interface TickRecord {
  quantity: number;
  side: "buy" | "sell";
  timestamp: number;
}

/**
 * Cumulative Volume Delta.
 * Sums (buy qty - sell qty) for all ticks within `windowMs` of `now`.
 * Result is in base asset units: positive = net buying, negative = net selling.
 */
export function computeCVD(ticks: TickRecord[], windowMs: number, now: number): number {
  const cutoff = now - windowMs;
  let cvd = 0;
  for (const tick of ticks) {
    if (tick.timestamp < cutoff) continue;
    cvd += tick.side === "buy" ? tick.quantity : -tick.quantity;
  }
  return cvd;
}
