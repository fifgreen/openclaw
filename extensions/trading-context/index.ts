import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "./runtime-api.js";
import { readRecentJournalEntries } from "./src/engine/Journaler.js";
import { riskGateHook } from "./src/hooks/risk-gate.js";

export * from "./src/api.js";

export default definePluginEntry({
  id: "trading-context",
  name: "Trading Context",
  description:
    "MemDir shared state, ContextEngine, HaltProtocol, and decision journaling for trading agents",
  register(api: OpenClawPluginApi) {
    const journalDir: string | undefined = (() => {
      const raw = api.pluginConfig;
      if (raw && typeof raw === "object" && "journalDir" in raw) {
        const d = (raw as Record<string, unknown>)["journalDir"];
        return typeof d === "string" ? d : undefined;
      }
      return undefined;
    })();

    // Register the before-tool-call risk gate (T018)
    api.on("before_tool_call", riskGateHook);

    // Register history query tools (T015b / FR-004)
    // History is sourced from the persisted decision journal (JSONL) so it survives across
    // restarts and doesn't require an in-memory session store.
    api.registerTool(
      (_ctx) => ({
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
          if (!journalDir) {
            const result = { entries: [], note: "journalDir not configured" };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: result,
            };
          }
          const limit = typeof params["limit"] === "number" ? Math.max(1, params["limit"]) : 20;
          try {
            const entries = await readRecentJournalEntries(journalDir, limit);
            const result = { entries, total: entries.length };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: result,
            };
          } catch {
            const result = { entries: [], error: "journal not yet initialised" };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: result,
            };
          }
        },
      }),
      { names: ["get_session_history"] },
    );

    api.registerTool(
      (_ctx) => ({
        name: "get_last_decision",
        label: "Get Last Decision",
        description: "Retrieve the most recent journaled trading decision.",
        parameters: {
          type: "object" as const,
          properties: {},
          required: [],
        },
        async execute(_toolCallId: string, _params: Record<string, unknown>) {
          if (!journalDir) {
            const result = { decision: null, note: "journalDir not configured" };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: result,
            };
          }
          try {
            const entries = await readRecentJournalEntries(journalDir, 1);
            const result = { decision: entries[0] ?? null };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: result,
            };
          } catch {
            const result = { decision: null, error: "journal not yet initialised" };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: result,
            };
          }
        },
      }),
      { names: ["get_last_decision"] },
    );

    // Register informational snapshot tools (T019)
    api.registerTool(
      (_ctx) => ({
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
          const memDir = mkMemDir({ client: getRedisClient() });

          const [macro, fg, fr, sent, halt] = await Promise.all([
            memDir.get({ key: "macro_regime", symbol }),
            memDir.get({ key: "fear_greed", symbol }),
            memDir.get({ key: "funding_rate", symbol }),
            memDir.get({ key: "sentiment", symbol }),
            memDir.get({ key: "trading_halted", symbol: "*" }),
          ]);

          const result = {
            symbol,
            trading_halted: halt?.value ?? null,
            macro_regime: macro?.value ?? null,
            fear_greed: fg?.value ?? null,
            funding_rate: fr?.value ?? null,
            sentiment: sent?.value ?? null,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      }),
      { names: ["get_market_snapshot"] },
    );

    api.registerTool(
      (_ctx) => ({
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
          const memDir = mkMemDir({ client: getRedisClient() });

          const fr = await memDir.get({ key: "funding_rate", symbol });
          const result = {
            symbol,
            funding_rate: fr?.value ?? null,
            note: "Full quant feature vector available after Phase 1 (market data ingestion) is built.",
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      }),
      { names: ["get_quant_features"] },
    );
  },
});
