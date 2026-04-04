// Local type mirrors of the plugin SDK's before_tool_call event/result shapes.
// These types are not yet exported from openclaw/plugin-sdk/core; define locally
// to avoid importing from internal src/**. Keep in sync with src/plugins/types.ts.
type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};
type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};
import { getRedisClient } from "../memdir/index.js";
import { createMemDir } from "../memdir/MemDir.js";

// Tools that must be blocked when trading_halted is set or MemDir is stale
const ORDER_TOOL_NAMES = new Set(["place_order", "cancel_order", "modify_order"]);

/**
 * before-tool-call risk gate.
 *
 * Checks before any order placement tool:
 *   1. trading_halted flag in MemDir — block if set
 *   2. MemDir freshness (macro_regime) — block if stale
 */
export async function riskGateHook(
  event: PluginHookBeforeToolCallEvent,
): Promise<PluginHookBeforeToolCallResult | void> {
  if (!ORDER_TOOL_NAMES.has(event.toolName)) return;

  // Parse symbol from tool params (best-effort)
  const symbol =
    typeof event.params["symbol"] === "string"
      ? event.params["symbol"].toLowerCase().replace("/", "").slice(0, 6) // "BTC/USDT" → "btcusd"
      : "*";

  const memDir = createMemDir({ client: getRedisClient() });

  // Check 1: trading_halted
  const haltFlag = await memDir.get({ key: "trading_halted", symbol: "*" });
  if (haltFlag?.value.halted) {
    return {
      block: true,
      blockReason: `Trading is halted: ${haltFlag.value.reason}. Send /trading resume to restart.`,
    };
  }

  // Check 2: stale macro regime (if present and expired, treat as risk-gate)
  const macroRegime = await memDir.get({ key: "macro_regime", symbol });
  if (macroRegime === null) {
    // No macro data available — warn but do not block (may be before Phase 1 is built)
    return;
  }

  // If we get here, MemDir is fresh and trading is not halted — allow the tool call
}
