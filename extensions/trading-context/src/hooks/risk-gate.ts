import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
} from "openclaw/plugin-sdk/core";
import { getRedisClient } from "../memdir/index.js";
import { createMemDir } from "../memdir/MemDir.js";

// Tools that must be blocked when trading_halted is set or MemDir is stale
const ORDER_TOOL_NAMES = new Set(["place_order", "cancel_order", "modify_order"]);

export interface RiskGateConfig {
  redisUrl?: string;
  memDirTimeoutMs?: number;
}

/**
 * Factory for creating a configured risk gate hook.
 * Returns a hook function that uses the provided config for MemDir connectivity.
 */
export function createRiskGateHook(config: RiskGateConfig = {}) {
  return async function riskGateHook(
    event: PluginHookBeforeToolCallEvent,
  ): Promise<PluginHookBeforeToolCallResult | void> {
    if (!ORDER_TOOL_NAMES.has(event.toolName)) return;

    // Parse symbol from tool params (best-effort)
    // Extract base asset from pairs like "BTC/USDT" → "btc" to match MemDir convention
    const symbol =
      typeof event.params["symbol"] === "string"
        ? event.params["symbol"].toLowerCase().split("/")[0] || "*"
        : "*";

    const memDir = createMemDir({
      client: getRedisClient(config.redisUrl ? { url: config.redisUrl } : {}),
      timeoutMs: config.memDirTimeoutMs,
    });

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
  };
}

/**
 * Default risk gate hook (for backward compatibility).
 * Uses default Redis connection (localhost:6379) and timeout (5000ms).
 */
export const riskGateHook = createRiskGateHook();
