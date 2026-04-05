import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "./runtime-api.js";
import { getPool, closePool } from "./src/db/client.js";
import type { PriceTickRecord, OBSnapshotRecord } from "./src/feature-vector/builder.js";
import { createFeatureVectorCache } from "./src/feature-vector/cache.js";
import { buildGetIndicatorsTool } from "./src/tools/get-indicators.js";
import { buildGetOrderFlowTool } from "./src/tools/get-order-flow.js";
import { buildGetQuantFeaturesTool } from "./src/tools/get-quant-features.js";

export * from "./src/api.js";

const DEFAULT_SYMBOLS = ["BTC/USDT", "ETH/USDT"];
const CACHE_TTL_MS = 1_000;

export default definePluginEntry({
  id: "quant-math-engine",
  name: "Quant Math Engine",
  description:
    "Technical indicators, order flow analytics, statistical models, and risk mathematics " +
    "for trading agents. Exposes get_indicators, get_order_flow, and get_quant_features tools.",
  register(api: OpenClawPluginApi) {
    // In-process state shared between service lifecycle and tool handlers.
    const tickBuffers = new Map<string, PriceTickRecord[]>();
    const obSnapshots = new Map<string, OBSnapshotRecord>();
    const spreadHistories = new Map<string, number[]>();

    const cache = createFeatureVectorCache(CACHE_TTL_MS);

    function getTicks(symbol: string): PriceTickRecord[] {
      return tickBuffers.get(symbol) ?? [];
    }

    function getOBSnapshot(symbol: string): OBSnapshotRecord | null {
      return obSnapshots.get(symbol) ?? null;
    }

    function getSpreadHistory(symbol: string): number[] {
      return spreadHistories.get(symbol) ?? [];
    }

    // Expose setters for the service start() to populate via market-data-ingestion events.
    // In production, the plugin listens for SDK events from market-data-ingestion's store.
    // Here we wire up defaults so tools work without market-data-ingestion in dev/test mode.
    let pool: ReturnType<typeof getPool> | null = null;

    api.registerService({
      id: "quant-math-engine",
      async start(ctx) {
        const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
        const timescaleUrl =
          typeof cfg["timescaleUrl"] === "string" ? cfg["timescaleUrl"] : undefined;
        const symbols = Array.isArray(cfg["symbols"])
          ? (cfg["symbols"] as unknown[]).map(String)
          : DEFAULT_SYMBOLS;
        const orderflowWindowMs =
          typeof (cfg["orderflow"] as Record<string, unknown> | undefined)?.["windowMs"] ===
          "number"
            ? ((cfg["orderflow"] as Record<string, unknown>)["windowMs"] as number)
            : 60_000;
        const largeTradeThresholdUsd =
          typeof (cfg["orderflow"] as Record<string, unknown> | undefined)?.[
            "largeTradeThresholdUsd"
          ] === "number"
            ? ((cfg["orderflow"] as Record<string, unknown>)["largeTradeThresholdUsd"] as number)
            : 10_000;

        ctx.logger.info(
          `[quant-math-engine] starting — symbols=${symbols.join(",")} ` +
            `orderflow.windowMs=${orderflowWindowMs} ` +
            `largeTradeThresholdUsd=${largeTradeThresholdUsd}`,
        );

        if (timescaleUrl) {
          pool = getPool(timescaleUrl);
        }

        // Initialize empty rolling buffers for each symbol.
        for (const sym of symbols) {
          tickBuffers.set(sym, []);
          spreadHistories.set(sym, []);
        }
      },
      async stop(ctx) {
        ctx.logger.info("[quant-math-engine] stopping");
        cache.clear();
        await closePool();
      },
    });

    // Shared runtime config built lazily on first use.
    function buildRuntimeCfg() {
      const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
      const riskCfg = (cfg["risk"] as Record<string, unknown> | undefined) ?? {};
      const orderflowCfg = (cfg["orderflow"] as Record<string, unknown> | undefined) ?? {};

      return {
        hurstWindow:
          typeof (cfg["hurst"] as Record<string, unknown> | undefined)?.["window"] === "number"
            ? ((cfg["hurst"] as Record<string, unknown>)["window"] as number)
            : 100,
        orderflowWindowMs:
          typeof orderflowCfg["windowMs"] === "number"
            ? (orderflowCfg["windowMs"] as number)
            : 60_000,
        largeTradeThresholdUsd:
          typeof orderflowCfg["largeTradeThresholdUsd"] === "number"
            ? (orderflowCfg["largeTradeThresholdUsd"] as number)
            : 10_000,
        spreadHistoryLength:
          typeof orderflowCfg["spreadHistoryLength"] === "number"
            ? (orderflowCfg["spreadHistoryLength"] as number)
            : 50,
        varConfidence95: 1.645,
        varConfidence99: 2.326,
        risk: {
          maxKellyFraction:
            typeof riskCfg["maxKellyFraction"] === "number"
              ? (riskCfg["maxKellyFraction"] as number)
              : 0.25,
          varConfidence95: 1.645,
          maxDrawdownHalt:
            typeof riskCfg["maxDrawdownHalt"] === "number"
              ? (riskCfg["maxDrawdownHalt"] as number)
              : 0.2,
          maxPositionRiskPct:
            typeof riskCfg["maxPositionRiskPct"] === "number"
              ? (riskCfg["maxPositionRiskPct"] as number)
              : 0.02,
        },
        accountEquity:
          typeof riskCfg["accountEquity"] === "number"
            ? (riskCfg["accountEquity"] as number)
            : 100_000,
        equityCurve: [100_000],
      };
    }

    api.registerTool(
      (_ctx) => {
        if (!pool) {
          throw new Error(
            "[quant-math-engine] TimescaleDB pool not initialized. Set plugins.quant-math-engine.config.timescaleUrl",
          );
        }
        return buildGetIndicatorsTool(pool);
      },
      { names: ["get_indicators"] },
    );

    api.registerTool(
      (_ctx) => {
        const orderFlowDeps = {
          getTicks,
          getOBSnapshot,
          getSpreadHistory,
          orderflowWindowMs: 60_000,
          largeTradeThresholdUsd: 10_000,
        };
        return buildGetOrderFlowTool(orderFlowDeps);
      },
      { names: ["get_order_flow"] },
    );

    api.registerTool(
      (_ctx) => {
        if (!pool) {
          throw new Error(
            "[quant-math-engine] TimescaleDB pool not initialized. Set plugins.quant-math-engine.config.timescaleUrl",
          );
        }
        const orderFlowDeps = {
          getTicks,
          getOBSnapshot,
          getSpreadHistory,
          orderflowWindowMs: 60_000,
          largeTradeThresholdUsd: 10_000,
        };
        return buildGetQuantFeaturesTool({
          pool,
          cache,
          orderFlow: orderFlowDeps,
          cfg: buildRuntimeCfg(),
        });
      },
      { names: ["get_quant_features"] },
    );
  },
});
