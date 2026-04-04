// ExchangeAdapter — typed contract for exchange operations used by HaltProtocol.
// Real Binance/Bybit implementations will be wired in Phase 5 of the roadmap.

export interface CancelResult {
  symbol: string;
  canceledOrderIds: string[];
  errors: string[];
}

export interface CloseResult {
  symbol: string;
  closedPositions: Array<{ positionId: string; closedAt: number; price: number }>;
  errors: string[];
}

export interface ExchangeAdapter {
  /**
   * Cancel all open orders for the given symbol.
   * Must not throw — use the `errors` array for failures.
   */
  cancelOrders(symbol: string): Promise<CancelResult>;

  /**
   * Close all open positions for the given symbol at market price.
   * Must not throw — use the `errors` array for failures.
   */
  closePositions(symbol: string): Promise<CloseResult>;
}

// ---------------------------------------------------------------------------
// HaltReason — closed code union for machine-readable halt triggers
// ---------------------------------------------------------------------------

export type HaltReason =
  | "invalid_strategy"
  | "consecutive_timeouts"
  | "max_drawdown_exceeded"
  | "manual_stop"
  | "redis_down";

export interface HaltContext {
  reason: HaltReason;
  symbol: string;
  message: string;
  triggeredAt: number;
}
