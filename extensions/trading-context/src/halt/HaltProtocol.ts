import type { DecisionJournaler } from "../engine/Journaler.js";
import type { MemDir } from "../memdir/MemDir.js";
import type { ExchangeAdapter, HaltContext, HaltReason } from "./types.js";

// ---------------------------------------------------------------------------
// NotificationAdapter — injectable interface for operator notifications.
// Real implementation (OpenClaw channel routing) is wired in T020.
// ---------------------------------------------------------------------------

export interface NotificationAdapter {
  sendAlert(message: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// HaltProtocol options
// ---------------------------------------------------------------------------

export interface HaltProtocolOptions {
  exchange: ExchangeAdapter;
  memDir: MemDir;
  notification: NotificationAdapter;
  journaler: DecisionJournaler;
  /** Cooldown between halt notifications (default: 60_000ms). */
  notificationCooldownMs?: number;
  /** Callback invoked to signal the tick loop should stop. */
  onStopTick?: (symbol: string) => void;
}

// ---------------------------------------------------------------------------
// HaltProtocol
// ---------------------------------------------------------------------------

export class HaltProtocol {
  private readonly exchange: ExchangeAdapter;
  private readonly memDir: MemDir;
  private readonly notification: NotificationAdapter;
  private readonly journaler: DecisionJournaler;
  private readonly notificationCooldownMs: number;
  private readonly onStopTick: ((symbol: string) => void) | undefined;
  /** Per-symbol last notification timestamp for deduplication. */
  private lastNotifiedAt = new Map<string, number>();

  constructor(opts: HaltProtocolOptions) {
    this.exchange = opts.exchange;
    this.memDir = opts.memDir;
    this.notification = opts.notification;
    this.journaler = opts.journaler;
    this.notificationCooldownMs = opts.notificationCooldownMs ?? 60_000;
    this.onStopTick = opts.onStopTick;
  }

  /**
   * Execute the full halt sequence. All steps are mandatory and ordered:
   * 1. Cancel open orders
   * 2. Close positions at market
   * 3. Set trading_halted in MemDir
   * 4. Send operator notification (with cooldown deduplication)
   * 5. Log to decision journal
   * 6. Stop tick loop
   */
  async execute(ctx: HaltContext): Promise<void> {
    const { symbol, reason, message, triggeredAt } = ctx;

    // Step 1: Cancel open orders
    const cancelResult = await this.exchange.cancelOrders(symbol);

    // Step 2: Close positions at market
    const closeResult = await this.exchange.closePositions(symbol);

    // Step 3: Set trading_halted in MemDir
    await this.memDir.set(
      { key: "trading_halted", symbol: "*" },
      { halted: true, reason: message, haltedAt: triggeredAt },
      { source: "halt-protocol" },
    );

    // Step 4: Send operator notification (deduped by cooldown)
    const lastAt = this.lastNotifiedAt.get(symbol) ?? 0;
    if (Date.now() - lastAt >= this.notificationCooldownMs) {
      this.lastNotifiedAt.set(symbol, Date.now());
      const alertMsg = [
        `🚨 HALT [${symbol.toUpperCase()}] — ${reason}`,
        `Reason: ${message}`,
        `Canceled orders: ${cancelResult.canceledOrderIds.length}`,
        `Closed positions: ${closeResult.closedPositions.length}`,
        ...(cancelResult.errors.length
          ? [`Order cancel errors: ${cancelResult.errors.join(", ")}`]
          : []),
        ...(closeResult.errors.length
          ? [`Close position errors: ${closeResult.errors.join(", ")}`]
          : []),
        `Send /trading resume to restart after fixing the issue.`,
      ].join("\n");
      await this.notification.sendAlert(alertMsg);
    }

    // Step 5: Log full halt context to decision journal
    await this.journaler.writeHalt({
      symbol,
      reason,
      message,
      triggeredAt,
      canceledOrderIds: cancelResult.canceledOrderIds,
      closedPositions: closeResult.closedPositions,
      cancelErrors: cancelResult.errors,
      closeErrors: closeResult.errors,
    });

    // Step 6: Stop tick loop
    this.onStopTick?.(symbol);
  }

  /** Build a HaltContext and execute. Convenience wrapper. */
  async trigger(params: { symbol: string; reason: HaltReason; message: string }): Promise<void> {
    await this.execute({
      ...params,
      triggeredAt: Date.now(),
    });
  }
}
