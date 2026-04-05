import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "./runtime-api.js";
import { BinanceAdapter } from "./src/adapters/BinanceAdapter.js";
import { BybitAdapter } from "./src/adapters/BybitAdapter.js";
import {
  startBuffers,
  stopBuffers,
  getPriceTickBuffer,
  getOBSnapshotBuffer,
  getFundingRateBuffer,
} from "./src/db/buffers.js";
import { closePool } from "./src/db/client.js";
import { createMarketDataStore } from "./src/market-data-store.js";
import { fetchBinanceSnapshot, fetchBybitSnapshot } from "./src/ob/fetch-snapshot.js";
import { OrderBookStateMachine } from "./src/ob/OrderBookStateMachine.js";
import { closeRateLimitWorkers } from "./src/ratelimit/queues.js";
import { buildBootstrapHistoricalDataTool } from "./src/tools/bootstrap-historical-data.js";
import { buildGetFundingRateTool } from "./src/tools/get-funding-rate.js";
import { buildGetLatestTickTool } from "./src/tools/get-latest-tick.js";
import { buildGetOBSnapshotTool } from "./src/tools/get-ob-snapshot.js";
import { buildGetOHLCVTool } from "./src/tools/get-ohlcv.js";

export * from "./src/api.js";

export default definePluginEntry({
  id: "market-data-ingestion",
  name: "Market Data Ingestion",
  description:
    "Real-time Binance/Bybit WebSocket adapters, order book state machine, TimescaleDB persistence, BullMQ rate limiter, and historical bootstrap CLI for trading agents",
  register(api: OpenClawPluginApi) {
    // Shared in-process store — created once, shared between service and tools.
    const store = createMarketDataStore();

    // Register background service for WS adapter lifecycle.
    // start() is called when the gateway activates plugins;
    // stop() is called on graceful shutdown.
    api.registerService({
      id: "market-data-ingestion",
      async start(ctx) {
        const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
        const symbols = Array.isArray(cfg["symbols"])
          ? (cfg["symbols"] as unknown[]).map(String)
          : ["BTC/USDT", "ETH/USDT"];
        const flushMaxRows =
          (cfg["flush"] as Record<string, number> | undefined)?.["maxRows"] ?? 1000;
        const flushIntervalMs =
          (cfg["flush"] as Record<string, number> | undefined)?.["intervalMs"] ?? 500;
        const timescaleUrl =
          typeof cfg["timescaleUrl"] === "string" ? cfg["timescaleUrl"] : undefined;
        const sampleObEveryMs =
          typeof cfg["sampleObEveryMs"] === "number" ? cfg["sampleObEveryMs"] : 100;

        ctx.logger.info(
          `[market-data-ingestion] starting — symbols=${symbols.join(",")} flush.maxRows=${flushMaxRows}`,
        );

        // Initialize the pool with the configured timescaleUrl (if provided)
        if (timescaleUrl) {
          const { getPool } = await import("./src/db/client.js");
          getPool(timescaleUrl);
        }

        // Start periodic cleanup of expired entries in the market data store
        store.startCleanup();

        startBuffers({ maxRows: flushMaxRows, flushIntervalMs });

        // One OB state machine per exchange per symbol.
        const obMachines = new Map<string, OrderBookStateMachine>();
        const obLastSampleTime = new Map<string, number>();

        for (const sym of symbols) {
          for (const ex of ["binance", "bybit"] as const) {
            const fetchFn = ex === "binance" ? fetchBinanceSnapshot : fetchBybitSnapshot;
            const machine = new OrderBookStateMachine({
              exchange: ex,
              symbol: sym,
              depth: 20,
              fetchSnapshot: fetchFn,
            });
            const key = `${ex}:${sym}`;
            machine.onLive((snapshot) => {
              store.setOB(ex, sym, snapshot);
              // Throttle OB snapshot writes to DB based on sampleObEveryMs
              const now = Date.now();
              const lastSample = obLastSampleTime.get(key) ?? 0;
              if (now - lastSample >= sampleObEveryMs) {
                getOBSnapshotBuffer().push(snapshot);
                obLastSampleTime.set(key, now);
              }
            });
            obMachines.set(key, machine);
          }
        }

        const binance = new BinanceAdapter();
        const bybit = new BybitAdapter();

        binance.onTick((tick) => {
          store.setTick("binance", tick.symbol, tick);
          getPriceTickBuffer().push(tick);
        });
        binance.onOBDelta((delta) => {
          obMachines.get(`binance:${delta.symbol}`)?.applyDelta(delta);
        });
        binance.onFundingRate((rate) => {
          store.setFunding("binance", rate.symbol, rate);
          getFundingRateBuffer().push(rate);
        });

        bybit.onTick((tick) => {
          store.setTick("bybit", tick.symbol, tick);
          getPriceTickBuffer().push(tick);
        });
        bybit.onOBDelta((delta) => {
          obMachines.get(`bybit:${delta.symbol}`)?.applyDelta(delta);
        });
        bybit.onFundingRate((rate) => {
          store.setFunding("bybit", rate.symbol, rate);
          getFundingRateBuffer().push(rate);
        });

        binance.subscribe(symbols);
        bybit.subscribe(symbols);

        await binance.connect();
        await bybit.connect();

        // Store adapters on the context for stop() to access.
        (ctx as Record<string, unknown>)["_mdi_binance"] = binance;
        (ctx as Record<string, unknown>)["_mdi_bybit"] = bybit;
      },
      async stop(ctx) {
        ctx.logger.info("[market-data-ingestion] stopping");
        const binance = (ctx as Record<string, unknown>)["_mdi_binance"] as
          | BinanceAdapter
          | undefined;
        const bybit = (ctx as Record<string, unknown>)["_mdi_bybit"] as BybitAdapter | undefined;
        await Promise.allSettled([binance?.disconnect(), bybit?.disconnect()]);
        store.stopCleanup();
        await stopBuffers();
        await closePool();
        await closeRateLimitWorkers();
      },
    });

    // T040: Register the 5 OpenClaw tools.
    api.registerTool((_ctx) => buildGetLatestTickTool(store), { names: ["get_latest_tick"] });
    api.registerTool((_ctx) => buildGetOBSnapshotTool(store), { names: ["get_ob_snapshot"] });
    api.registerTool((_ctx) => buildGetFundingRateTool(store), { names: ["get_funding_rate"] });
    api.registerTool((_ctx) => buildGetOHLCVTool(), { names: ["get_ohlcv"] });
    api.registerTool((_ctx) => buildBootstrapHistoricalDataTool(), {
      names: ["bootstrap_historical_data"],
    });
  },
});
