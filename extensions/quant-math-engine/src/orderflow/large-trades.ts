export interface LargeTickRecord {
  quantity: number;
  side: "buy" | "sell";
  price: number;
  timestamp: number;
}

export interface LargeTradeResult {
  count: number;
  /** Positive = net buy pressure from large trades; negative = net sell. */
  netBias: number;
}

/**
 * Detects trades where `qty × price > thresholdUsd` within `windowMs` of `now`.
 * Returns the count and net bias (sum of buy qty - sum of sell qty for large trades).
 */
export function detectLargeTrades(
  ticks: LargeTickRecord[],
  thresholdUsd: number,
  windowMs: number,
  now: number,
): LargeTradeResult {
  const cutoff = now - windowMs;
  let count = 0;
  let netBias = 0;

  for (const tick of ticks) {
    if (tick.timestamp < cutoff) continue;
    const notional = tick.quantity * tick.price;
    if (notional <= thresholdUsd) continue;
    count++;
    netBias += tick.side === "buy" ? tick.quantity : -tick.quantity;
  }

  return { count, netBias };
}
