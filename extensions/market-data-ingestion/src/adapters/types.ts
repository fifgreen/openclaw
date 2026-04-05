import type { FundingRate } from "../schema/FundingRate.js";
import type { OrderBookSnapshot } from "../schema/OrderBookSnapshot.js";
import type { PriceTick } from "../schema/PriceTick.js";

/** Common interface implemented by both BinanceAdapter and BybitAdapter. */
export interface ExchangeAdapter {
  /** Opens WebSocket connection(s) and begins receiving market data. */
  connect(): Promise<void>;
  /** Gracefully closes all WebSocket connections. */
  disconnect(): Promise<void>;
  /** Subscribes to the given symbol set (BASE/QUOTE notation, e.g. "BTC/USDT"). */
  subscribe(symbols: string[]): void;
  /** Register a callback for normalized price tick events. */
  onTick(cb: (tick: PriceTick) => void): void;
  /** Register a callback for order book delta events. */
  onOBDelta(cb: (snapshot: OrderBookSnapshot) => void): void;
  /** Register a callback for funding rate update events. */
  onFundingRate(cb: (rate: FundingRate) => void): void;
}
