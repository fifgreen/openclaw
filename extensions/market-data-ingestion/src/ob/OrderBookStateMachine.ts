import type { Exchange } from "../ratelimit/queues.js";
import type { OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";

export type OBStatus = "uninitialized" | "snapshotting" | "live" | "resyncing";

type FetchSnapshotFn = (symbol: string, depth: number) => Promise<OrderBookSnapshot>;

/** Price level: [price, quantity] */
type Level = [number, number];

/** Listeners notified when the machine transitions to "live". */
type LiveListener = (snapshot: OrderBookSnapshot) => void;

/**
 * OrderBookStateMachine manages the local order book for one (exchange, symbol) pair.
 *
 * States:
 *  - uninitialized: no snapshot yet
 *  - snapshotting:  fetching initial REST snapshot
 *  - live:          applying deltas normally
 *  - resyncing:     gap detected; buffering deltas, fetching new snapshot
 *
 * Bids are sorted descending (best bid first).
 * Asks are sorted ascending (best ask first).
 */
export class OrderBookStateMachine {
  readonly exchange: Exchange;
  readonly symbol: string;

  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private _status: OBStatus = "uninitialized";
  private lastSequenceId = -1;
  private pendingDeltas: OrderBookSnapshot[] = [];
  private readonly depth: number;
  private readonly fetchSnapshot: FetchSnapshotFn;
  private readonly liveListeners: LiveListener[] = [];

  constructor(opts: {
    exchange: Exchange;
    symbol: string;
    depth?: number;
    fetchSnapshot: FetchSnapshotFn;
  }) {
    this.exchange = opts.exchange;
    this.symbol = opts.symbol;
    this.depth = opts.depth ?? 20;
    this.fetchSnapshot = opts.fetchSnapshot;
  }

  get status(): OBStatus {
    return this._status;
  }

  /** Register a listener called each time the machine transitions to (or stays in) live. */
  onLive(cb: LiveListener): void {
    this.liveListeners.push(cb);
  }

  /**
   * Apply an incoming OB delta.
   * - gap detected → transition to "resyncing", buffer the delta, fetch new snapshot
   * - duplicate seqId → discard silently
   * - qty === 0 → remove the price level
   */
  applyDelta(delta: OrderBookSnapshot): void {
    if (this._status === "uninitialized") {
      // Kick off initial snapshot fetch
      this._status = "snapshotting";
      this.pendingDeltas = [delta];
      this.doFetchSnapshot().catch((err: unknown) => {
        console.warn(`[OBStateMachine] snapshot fetch failed for ${this.symbol}:`, err);
        this._status = "uninitialized";
      });
      return;
    }

    if (this._status === "resyncing" || this._status === "snapshotting") {
      // Buffer deltas; they will be replayed after snapshot completes
      this.pendingDeltas.push(delta);
      return;
    }

    // status === "live"
    const { sequenceId } = delta;

    if (sequenceId <= this.lastSequenceId) {
      // Stale/duplicate — discard silently
      return;
    }

    if (
      this.lastSequenceId !== -1 &&
      sequenceId !== this.lastSequenceId + 1 &&
      // Allow gaps of exactly 1 (some exchanges skip IDs in depth-only updates)
      sequenceId > this.lastSequenceId + 1
    ) {
      console.warn(
        `[OBStateMachine] gap detected for ${this.exchange}:${this.symbol} ` +
          `(expected ${this.lastSequenceId + 1}, got ${sequenceId}) — resyncing`,
      );
      this._status = "resyncing";
      this.pendingDeltas = [delta];
      this.doFetchSnapshot().catch((err: unknown) => {
        console.warn(`[OBStateMachine] resync snapshot fetch failed:`, err);
        this._status = "uninitialized";
      });
      return;
    }

    this.applyLevels(delta);
    this.lastSequenceId = sequenceId;
    this.notifyLive();
  }

  /** Return the top `depth` bid/ask levels when status is "live", else undefined. */
  getTopOfBook(depth: number = this.depth): { bids: Level[]; asks: Level[] } | undefined {
    if (this._status !== "live") return undefined;

    const bids = [...this.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, depth)
      .map(([p, q]) => [p, q] as Level);

    const asks = [...this.asks.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, depth)
      .map(([p, q]) => [p, q] as Level);

    return { bids, asks };
  }

  /** Returns mid-price when live, else undefined. */
  getMidprice(): number | undefined {
    if (this._status !== "live") return undefined;
    const bestBid = [...this.bids.keys()].sort((a, b) => b - a)[0];
    const bestAsk = [...this.asks.keys()].sort((a, b) => a - b)[0];
    if (bestBid === undefined || bestAsk === undefined) return undefined;
    return (bestBid + bestAsk) / 2;
  }

  /** Returns spread (ask - bid) when live, else undefined. */
  getSpread(): number | undefined {
    if (this._status !== "live") return undefined;
    const bestBid = [...this.bids.keys()].sort((a, b) => b - a)[0];
    const bestAsk = [...this.asks.keys()].sort((a, b) => a - b)[0];
    if (bestBid === undefined || bestAsk === undefined) return undefined;
    return bestAsk - bestBid;
  }

  /**
   * Returns order book imbalance (bid_vol / (bid_vol + ask_vol)) for the
   * top `depth` levels when live, else undefined.
   */
  getImbalance(depth: number = 5): number | undefined {
    if (this._status !== "live") return undefined;
    const top = this.getTopOfBook(depth);
    if (!top) return undefined;
    const bidVol = top.bids.reduce((s, [, q]) => s + q, 0);
    const askVol = top.asks.reduce((s, [, q]) => s + q, 0);
    const total = bidVol + askVol;
    return total > 0 ? bidVol / total : undefined;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private applyLevels(delta: OrderBookSnapshot): void {
    for (const [price, qty] of delta.bids) {
      if (qty === 0) {
        this.bids.delete(price);
      } else {
        this.bids.set(price, qty);
      }
    }
    for (const [price, qty] of delta.asks) {
      if (qty === 0) {
        this.asks.delete(price);
      } else {
        this.asks.set(price, qty);
      }
    }
  }

  private async doFetchSnapshot(): Promise<void> {
    const snapshot = await this.fetchSnapshot(this.symbol, this.depth);
    // Rebuild book from snapshot
    this.bids = new Map(snapshot.bids.map(([p, q]) => [p, q]));
    this.asks = new Map(snapshot.asks.map(([p, q]) => [p, q]));
    this.lastSequenceId = snapshot.sequenceId;
    this._status = "live";

    // Replay buffered deltas in order
    const buffered = this.pendingDeltas.splice(0);
    for (const delta of buffered) {
      // Use direct application (skip gap logic for buffered deltas)
      if (delta.sequenceId > this.lastSequenceId) {
        this.applyLevels(delta);
        this.lastSequenceId = delta.sequenceId;
      }
    }

    this.notifyLive();
    console.info(
      `[OBStateMachine] ${this.exchange}:${this.symbol} status=live seqId=${this.lastSequenceId}`,
    );
  }

  private notifyLive(): void {
    const top = this.getTopOfBook();
    if (!top) return;

    const snapshot: OrderBookSnapshot = {
      exchange: this.exchange,
      symbol: this.symbol,
      bids: top.bids,
      asks: top.asks,
      depth: this.depth,
      sequenceId: this.lastSequenceId,
      timestamp: Date.now(),
    };

    for (const cb of this.liveListeners) cb(snapshot);
  }
}
