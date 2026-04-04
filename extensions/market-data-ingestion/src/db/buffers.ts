import type { FundingRate } from "../schema/FundingRate.js";
import type { OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";
import type { PriceTick } from "../schema/PriceTick.js";
import { batchInsertTicks, batchInsertOBSnapshots, batchInsertFundingRates } from "./queries.js";
import { WriteBuffer } from "./WriteBuffer.js";

// These singletons are created lazily so unit tests can safely import the
// module without triggering pg connections. Call `startBuffers()` on plugin
// activation and `stopBuffers()` on deactivation.

let _priceTickBuffer: WriteBuffer<PriceTick> | null = null;
let _obSnapshotBuffer: WriteBuffer<OrderBookSnapshot> | null = null;
let _fundingRateBuffer: WriteBuffer<FundingRate> | null = null;

function makeBuffers(opts: { maxRows?: number; flushIntervalMs?: number }) {
  const maxRows = opts.maxRows ?? 1000;
  const flushIntervalMs = opts.flushIntervalMs ?? 500;

  _priceTickBuffer = new WriteBuffer<PriceTick>({
    maxRows,
    flushIntervalMs,
    maxQueueDepth: 10_000, // ticks use bounded queue; oldest dropped under overflow
    onFlush: batchInsertTicks,
  });

  _obSnapshotBuffer = new WriteBuffer<OrderBookSnapshot>({
    maxRows,
    flushIntervalMs,
    maxQueueDepth: Infinity, // OB rows must never be dropped
    onFlush: batchInsertOBSnapshots,
  });

  _fundingRateBuffer = new WriteBuffer<FundingRate>({
    maxRows,
    flushIntervalMs,
    maxQueueDepth: Infinity, // Funding rate rows must never be dropped
    onFlush: batchInsertFundingRates,
  });
}

/** Start all write buffer flush timers. Call on plugin activation. */
export function startBuffers(opts: { maxRows?: number; flushIntervalMs?: number } = {}): void {
  if (!_priceTickBuffer) makeBuffers(opts);
  _priceTickBuffer!.start();
  _obSnapshotBuffer!.start();
  _fundingRateBuffer!.start();
}

/** Drain all write buffers and stop their timers. Call on plugin deactivation. */
export async function stopBuffers(): Promise<void> {
  await Promise.all([
    _priceTickBuffer?.stop() ?? Promise.resolve(),
    _obSnapshotBuffer?.stop() ?? Promise.resolve(),
    _fundingRateBuffer?.stop() ?? Promise.resolve(),
  ]);
  _priceTickBuffer = null;
  _obSnapshotBuffer = null;
  _fundingRateBuffer = null;
}

/** Returns the singleton price tick WriteBuffer (starts it if not already started). */
export function getPriceTickBuffer(): WriteBuffer<PriceTick> {
  if (!_priceTickBuffer) {
    makeBuffers({});
    _priceTickBuffer!.start();
  }
  return _priceTickBuffer!;
}

/** Returns the singleton OB snapshot WriteBuffer. */
export function getOBSnapshotBuffer(): WriteBuffer<OrderBookSnapshot> {
  if (!_obSnapshotBuffer) {
    makeBuffers({});
    _obSnapshotBuffer!.start();
  }
  return _obSnapshotBuffer!;
}

/** Returns the singleton funding rate WriteBuffer. */
export function getFundingRateBuffer(): WriteBuffer<FundingRate> {
  if (!_fundingRateBuffer) {
    makeBuffers({});
    _fundingRateBuffer!.start();
  }
  return _fundingRateBuffer!;
}
