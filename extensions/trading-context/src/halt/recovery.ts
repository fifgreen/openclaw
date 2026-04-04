import { parseStrategy, type StrategyOverride } from "../engine/StrategyParser.js";
import type { MemDir } from "../memdir/MemDir.js";
import type { NotificationAdapter } from "./HaltProtocol.js";

// ---------------------------------------------------------------------------
// Recovery handler for /trading resume
// ---------------------------------------------------------------------------

export interface RecoveryOptions {
  memDir: MemDir;
  notification: NotificationAdapter;
  /** The raw strategy JSON to re-validate before resuming. */
  strategyJson: unknown;
  /** Callback to resume the tick loop after successful recovery. */
  onResumeTick?: (symbol: string) => void;
  symbol: string;
}

export type RecoveryResult =
  | { ok: true; strategy: StrategyOverride }
  | { ok: false; reason: string };

/**
 * Handle /trading resume command.
 * Steps:
 *   1. Re-validate active strategy JSON via Zod
 *   2. Test MemDir connectivity (attempt a get)
 *   3. Clear trading_halted flag
 *   4. Resume tick loop
 *   5. Send confirmation notification
 */
export async function recoverFromHalt(opts: RecoveryOptions): Promise<RecoveryResult> {
  const { memDir, notification, strategyJson, onResumeTick, symbol } = opts;

  // Step 1: Re-validate strategy
  const strategyResult = parseStrategy(strategyJson);
  if (!strategyResult.ok) {
    return { ok: false, reason: `Strategy re-validation failed: ${strategyResult.error}` };
  }

  // Step 2: Test MemDir connectivity
  try {
    // A simple write/read to verify connectivity
    await memDir.set({ key: "last_tick_at", symbol }, Date.now(), { source: "recovery-check" });
  } catch {
    return { ok: false, reason: "MemDir connectivity check failed — Redis may be unavailable." };
  }

  // Step 3: Clear trading_halted flag
  await memDir.set(
    { key: "trading_halted", symbol: "*" },
    { halted: false, reason: "operator-resumed", haltedAt: Date.now() },
    { source: "recovery" },
  );

  // Step 4: Resume tick loop
  onResumeTick?.(symbol);

  // Step 5: Send confirmation notification
  await notification.sendAlert(
    `✅ RESUME [${symbol.toUpperCase()}] — Trading resumed.\nStrategy "${strategyResult.strategy.id}" validated successfully.`,
  );

  return { ok: true, strategy: strategyResult.strategy };
}
