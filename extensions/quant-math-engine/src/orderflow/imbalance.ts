/**
 * Order Book Imbalance.
 * Returns the fraction of bid depth relative to total depth at the top `depth` levels.
 * Result in [0, 1]: 0 = all asks, 0.5 = balanced, 1 = all bids.
 * Returns 0.5 when both sides are empty.
 */
export function computeOBImbalance(
  bids: [number, number][],
  asks: [number, number][],
  depth: number,
): number {
  const bidQty = bids.slice(0, depth).reduce((sum, [, qty]) => sum + qty, 0);
  const askQty = asks.slice(0, depth).reduce((sum, [, qty]) => sum + qty, 0);
  const total = bidQty + askQty;
  if (total === 0) return 0.5;
  return bidQty / total;
}
