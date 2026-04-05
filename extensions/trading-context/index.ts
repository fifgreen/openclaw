import { jsonResult } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool, OpenClawPluginApi } from "./runtime-api.js";
import { readRecentJournalEntries } from "./src/engine/Journaler.js";
import { createRiskGateHook } from "./src/hooks/risk-gate.js";

export * from "./src/api.js";

export default definePluginEntry({
  id: "trading-context",
  name: "Trading Context",
  description:
    "MemDir shared state, ContextEngine, HaltProtocol, and decision journaling for trading agents",
  register(api: OpenClawPluginApi) {
    // Extract config fields from pluginConfig
    const config = (() => {
      const raw = api.pluginConfig;
      if (!raw || typeof raw !== "object") {
        return {
          redisUrl: undefined,
          memDirTimeoutMs: undefined,
          memDirConsecutiveTimeoutThreshold: undefined,
          haltNotificationCooldownMs: undefined,
          journalDir: undefined,
        };
      }
      const cfg = raw as Record<string, unknown>;
      return {
        redisUrl: typeof cfg["redisUrl"] === "string" ? cfg["redisUrl"] : undefined,
        memDirTimeoutMs:
          typeof cfg["memDirTimeoutMs"] === "number" ? cfg["memDirTimeoutMs"] : undefined,
        memDirConsecutiveTimeoutThreshold:
          typeof cfg["memDirConsecutiveTimeoutThreshold"] === "number"
            ? cfg["memDirConsecutiveTimeoutThreshold"]
            : undefined,
        haltNotificationCooldownMs:
          typeof cfg["haltNotificationCooldownMs"] === "number"
            ? cfg["haltNotificationCooldownMs"]
            : undefined,
        journalDir: typeof cfg["journalDir"] === "string" ? cfg["journalDir"] : undefined,
      };
    })();

    // Register the before-tool-call risk gate (T018) with config
    api.on(
      "before_tool_call",
      createRiskGateHook({
        redisUrl: config.redisUrl,
        memDirTimeoutMs: config.memDirTimeoutMs,
      }),
    );

    // Register history query tools (T015b / FR-004)
    // History is sourced from the persisted decision journal (JSONL) so it survives across
    // restarts and doesn't require an in-memory session store.
    api.registerTool(
      (_ctx) =>
        ({
          name: "get_session_history",
          label: "Get Session History",
          description:
            "Return recent trading decisions from the decision journal for the current month.",
          parameters: {
            type: "object" as const,
            properties: {
              limit: {
                type: "number",
                description: "Maximum number of recent entries to return (default: 20)",
              },
            },
            required: [],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            if (!config.journalDir) {
              return jsonResult({ entries: [], note: "journalDir not configured" });
            }
            const limit = typeof params["limit"] === "number" ? Math.max(1, params["limit"]) : 20;
            try {
              const entries = await readRecentJournalEntries(config.journalDir, limit);
              return jsonResult({ entries, total: entries.length });
            } catch {
              return jsonResult({ entries: [], error: "journal not yet initialised" });
            }
          },
        }) as AnyAgentTool,
      { names: ["get_session_history"] },
    );

    api.registerTool(
      (_ctx) =>
        ({
          name: "get_last_decision",
          label: "Get Last Decision",
          description: "Retrieve the most recent journaled trading decision.",
          parameters: {
            type: "object" as const,
            properties: {},
            required: [],
          },
          async execute(_toolCallId: string, _params: Record<string, unknown>) {
            if (!config.journalDir) {
              return jsonResult({ decision: null, note: "journalDir not configured" });
            }
            try {
              const entries = await readRecentJournalEntries(config.journalDir, 1);
              return jsonResult({ decision: entries[0] ?? null });
            } catch {
              return jsonResult({ decision: null, error: "journal not yet initialised" });
            }
          },
        }) as AnyAgentTool,
      { names: ["get_last_decision"] },
    );

    // Register informational snapshot tools (T019)
    api.registerTool(
      (_ctx) =>
        ({
          name: "get_market_snapshot",
          label: "Get Market Snapshot",
          description:
            "Read the current MemDir market state snapshot: macro regime, fear/greed, funding rate, and sentiment.",
          parameters: {
            type: "object" as const,
            properties: {
              symbol: {
                type: "string",
                description: "Trading symbol key (e.g. 'btc', 'eth')",
              },
            },
            required: ["symbol"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const { createMemDir: mkMemDir } = await import("./src/memdir/MemDir.js");
            const { getRedisClient } = await import("./src/memdir/index.js");
            const symbol = typeof params["symbol"] === "string" ? params["symbol"] : "btc";
            const memDir = mkMemDir({
              client: getRedisClient(config.redisUrl ? { url: config.redisUrl } : {}),
              timeoutMs: config.memDirTimeoutMs,
            });

            const [macro, fg, fr, sent, halt] = await Promise.all([
              memDir.get({ key: "macro_regime", symbol }),
              memDir.get({ key: "fear_greed", symbol }),
              memDir.get({ key: "funding_rate", symbol }),
              memDir.get({ key: "sentiment", symbol }),
              memDir.get({ key: "trading_halted", symbol: "*" }),
            ]);

            return jsonResult({
              symbol,
              trading_halted: halt?.value ?? null,
              macro_regime: macro?.value ?? null,
              fear_greed: fg?.value ?? null,
              funding_rate: fr?.value ?? null,
              sentiment: sent?.value ?? null,
            });
          },
        }) as AnyAgentTool,
      { names: ["get_market_snapshot"] },
    );

    api.registerTool(
      (_ctx) =>
        ({
          name: "get_quant_features",
          label: "Get Quant Features",
          description:
            "Read quantitative signal features from MemDir (populated by ingestion agents in Phase 1).",
          parameters: {
            type: "object" as const,
            properties: {
              symbol: {
                type: "string",
                description: "Trading symbol key (e.g. 'btc', 'eth')",
              },
            },
            required: ["symbol"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const { createMemDir: mkMemDir } = await import("./src/memdir/MemDir.js");
            const { getRedisClient } = await import("./src/memdir/index.js");
            const symbol = typeof params["symbol"] === "string" ? params["symbol"] : "btc";
            const memDir = mkMemDir({
              client: getRedisClient(config.redisUrl ? { url: config.redisUrl } : {}),
              timeoutMs: config.memDirTimeoutMs,
            });

            const fr = await memDir.get({ key: "funding_rate", symbol });
            return jsonResult({
              symbol,
              funding_rate: fr?.value ?? null,
              note: "Full quant feature vector available after Phase 1 (market data ingestion) is built.",
            });
          },
        }) as AnyAgentTool,
      { names: ["get_quant_features"] },
    );
  },
});
