# Implementation Plan: Quantitative Math Engine

**Feature**: 004-quant-math-engine
**Package**: `@openclaw/quant-math-engine`
**Location**: `extensions/quant-math-engine/`

---

## Tech Stack

| Layer           | Technology                                                                      |
| --------------- | ------------------------------------------------------------------------------- |
| Language        | TypeScript (ESM, strict)                                                        |
| Package manager | pnpm (workspace package)                                                        |
| Runtime         | Node 22+ / Bun                                                                  |
| Database        | TimescaleDB via `pg` (reads only — writes handled by market-data-ingestion)     |
| Testing         | Vitest, V8 coverage                                                             |
| Lint/Format     | Oxlint, Oxfmt                                                                   |
| Core SDK        | `openclaw/plugin-sdk/core`                                                      |
| Peer deps       | `@openclaw/trading-context` (MemDir), `@openclaw/market-data-ingestion` (types) |

**No external math libraries** — all indicators computed from OHLCV arrays using pure TypeScript arithmetic. This keeps the bundle lean and avoids licensing/version issues from TA-Lib or similar.

---

## Architecture

```
                    ┌──────────────────────────────────────┐
                    │      @openclaw/quant-math-engine      │
                    │                                       │
                    │  Plugin Entry (index.ts)              │
                    │    └─ registerService + registerTool  │
                    │                                       │
                    │  ┌──────────────┐  ┌───────────────┐ │
                    │  │  DB Layer    │  │  MemDir Layer │ │
                    │  │  queries.ts  │  │  (trading-    │ │
                    │  │  (OHLCV)     │  │   context)    │ │
                    │  └──────┬───────┘  └──────┬────────┘ │
                    │         │ OHLCV[]          │ Tick/OB  │
                    │         ▼                  ▼          │
                    │  ┌─────────────────────────────────┐  │
                    │  │       Computation Modules        │  │
                    │  │  indicators/ orderflow/ stats/   │  │
                    │  │  risk/                           │  │
                    │  └──────────────┬──────────────────┘  │
                    │                 │                      │
                    │                 ▼                      │
                    │  ┌──────────────────────────────────┐  │
                    │  │    QuantFeatureVector builder     │  │
                    │  │   feature-vector/builder.ts       │  │
                    │  └──────────────┬───────────────────┘  │
                    │                 │                      │
                    │       ┌─────────┴──────────┐          │
                    │       │    Agent Tools      │          │
                    │       │  get_indicators     │          │
                    │       │  get_order_flow     │          │
                    │       │  get_quant_features │          │
                    │       └────────────────────┘          │
                    └──────────────────────────────────────┘
                           ▲                   ▲
               TimescaleDB │                   │ Redis MemDir
          (OHLCV aggregates│                   │ (live ticks/OB)
       from market-data-   │                   │ via trading-context
            ingestion)     │                   │
```

**Key design decisions:**

- **Read-only from DB**: This plugin never writes to TimescaleDB. Writes are the market-data-ingestion plugin's responsibility.
- **In-process MemDir bridge**: Order flow analytics read live tick and OB data from the MemDir Redis store via `@openclaw/trading-context` helpers.
- **Pure-math computation**: No TA-Lib or external math libraries. Indicators are computed from OHLCV arrays using well-known formulas. This makes the module testable with synthetic data and avoids native binary dependencies.
- **Null-safe vectors**: Insufficient data returns `null` for that field rather than throwing. The `QuantFeatureVector` type uses `number | null` for fields with variable lookback requirements.
- **Caching**: A simple time-based cache (1-second TTL) prevents recomputing the full feature vector on every agent tool call within the same tick.

---

## File Structure

```
extensions/quant-math-engine/
├── index.ts                          # Plugin entry, tool registration, service lifecycle
├── runtime-api.ts                    # Re-exports from openclaw/plugin-sdk/core
├── openclaw.plugin.json              # Plugin manifest + configSchema
├── package.json                      # @openclaw/quant-math-engine, ESM, dependencies
├── tsconfig.json                     # Extends root tsconfig
│
└── src/
    ├── api.ts                        # Public exports (QuantFeatureVector type, tool input types)
    │
    ├── schema/
    │   ├── QuantFeatureVector.ts     # Full typed vector: indicators + orderflow + stats + risk
    │   └── QuantFeatureVector.test.ts
    │
    ├── db/
    │   ├── client.ts                 # Lazy pg Pool singleton (reads OHLCV from TimescaleDB)
    │   └── queries.ts                # queryOHLCV(symbol, timeframe, limit) → OHLCV[]
    │
    ├── indicators/
    │   ├── ema.ts                    # computeEMA(prices, period) → number | null
    │   ├── rsi.ts                    # computeRSI(prices, period) → number | null
    │   ├── macd.ts                   # computeMACD(prices) → { macd, signal, histogram } | null
    │   ├── bollinger.ts              # computeBollinger(prices, period, std) → BollingerResult | null
    │   ├── stochastic-rsi.ts         # computeStochRSI(prices, period) → number | null
    │   ├── adx.ts                    # computeADX(ohlcv, period) → number | null
    │   ├── atr.ts                    # computeATR(ohlcv, period) → number | null
    │   └── indicators.test.ts        # Unit tests for all indicator functions
    │
    ├── orderflow/
    │   ├── imbalance.ts              # computeOBImbalance(snapshot, depth) → number
    │   ├── cvd.ts                    # computeCVD(ticks, windowMs) → number
    │   ├── spread-zscore.ts          # computeSpreadZScore(current, history) → number | null
    │   ├── trade-flow.ts             # computeTradeFlow(ticks, windowMs) → TradeFlowResult
    │   ├── large-trades.ts           # detectLargeTrades(ticks, threshold) → LargeTradeResult
    │   └── orderflow.test.ts         # Unit tests for all order flow functions
    │
    ├── stats/
    │   ├── volatility.ts             # yangZhangVolatility(ohlcv, period) → number | null
    │   ├── hurst.ts                  # hurstExponent(prices, period) → number | null
    │   ├── correlation.ts            # rollingCorrelation(a, b, period) → number | null
    │   ├── regime.ts                 # detectRegime(hurst) → "trending" | "ranging" | "neutral"
    │   └── stats.test.ts             # Unit tests for all statistical functions
    │
    ├── risk/
    │   ├── kelly.ts                  # kellyFraction(winRate, avgWin, avgLoss) → number
    │   ├── var.ts                    # parametricVaR(vol, confidence, horizon) → number
    │   ├── drawdown.ts               # currentDrawdown(equityCurve) → number
    │   ├── position-size.ts          # computeMaxPositionSize(kelly, var, equity, cfg) → number
    │   └── risk.test.ts              # Unit tests for all risk functions
    │
    ├── feature-vector/
    │   ├── builder.ts                # buildQuantFeatureVector(symbol, cfg, deps) → Promise<QuantFeatureVector>
    │   ├── cache.ts                  # Simple 1-second TTL in-process cache
    │   └── feature-vector.test.ts    # Full vector builder tests with mocked deps
    │
    └── tools/
        ├── get-indicators.ts         # Tool: get_indicators(symbol, timeframe)
        ├── get-order-flow.ts         # Tool: get_order_flow(symbol)
        └── get-quant-features.ts     # Tool: get_quant_features(symbol)

test/
└── quant-math-engine.integration.test.ts  # Full pipeline: synthetic OHLCV → vector → tool response
```

---

## Data Model

### QuantFeatureVector

```typescript
interface QuantFeatureVector {
  symbol: string;
  timestamp: number; // Unix ms of computation

  // --- Technical Indicators ---
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi: number | null; // 0–100
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  bollingerPosition: number | null; // 0–1 (0=at lower, 1=at upper)
  stochRsi: number | null; // 0–1
  adx: number | null; // 0–100; >25 = trending
  atr: number | null; // Average True Range in price units

  // --- Order Flow ---
  obImbalance: number | null; // 0–1 (bid ratio at top N levels)
  cvd: number | null; // Cumulative Volume Delta (base asset units)
  tradeFlowBuyPct: number | null; // 0–1 (fraction of buyer-initiated trades)
  spreadZScore: number | null; // Standard deviations from rolling spread mean
  largeTradeCount: number | null; // Trades > threshold in the last hour
  largeTradeNetBias: number | null; // Positive = net buy pressure, negative = sell

  // --- Statistical Models ---
  realizedVol: number | null; // Annualized Yang-Zhang vol (e.g. 0.48 = 48%)
  hurstExponent: number | null; // 0–1 (>0.55 trending, <0.45 ranging)
  regime: "trending" | "ranging" | "neutral" | null;
  btcEthCorrelation: number | null; // -1 to 1

  // --- Risk Metrics ---
  var95: number | null; // 1-day 95% VaR as fraction of position value
  var99: number | null; // 1-day 99% VaR as fraction of position value
  currentDrawdown: number | null; // Current drawdown on equity curve (0–1)
  maxDrawdown: number | null; // Max drawdown in lookback window
  kellyFraction: number | null; // Raw Kelly fraction (before capping)
  kellyPositionSize: number | null; // Fractional Kelly × account equity
  maxPositionSize: number | null; // Final position cap (Kelly + VaR + drawdown gate)
  macroRegime: "risk-on" | "risk-off" | "neutral"; // Passed through from sentiment plugin
}
```

---

## Dependencies

### Runtime (`dependencies`)

- `pg` — PostgreSQL client (reads OHLCV from TimescaleDB)
- `zod` — Schema validation on DB query results

### Dev/Peer (`devDependencies` / `peerDependencies`)

- `openclaw` (workspace peer) — Plugin SDK
- `@types/pg` — TypeScript types for pg

### Consumed from other plugins (runtime via MemDir)

- `@openclaw/trading-context` — MemDir bridge, Redis KV reads (ticks, OB snapshots)
- `@openclaw/market-data-ingestion` — OHLCV types (imported via plugin-sdk pattern)

---

## Configuration Schema (`openclaw.plugin.json`)

```json
{
  "timescaleUrl": "string (postgres connection URL)",
  "symbols": "string[] (default: [\"BTC/USDT\", \"ETH/USDT\"])",
  "indicators": {
    "defaultTimeframe": "\"1m\" | \"5m\" | \"1h\" (default: \"15m\")",
    "ohlcvLookback": "number (candles to fetch, default: 300)"
  },
  "orderflow": {
    "windowMs": "number (tick window for CVD/trade flow, default: 300000 = 5m)",
    "largeTradeThresholdUsd": "number (default: 500000)",
    "spreadHistoryLength": "number (default: 100)"
  },
  "risk": {
    "maxKellyFraction": "number (default: 0.25 — cap Kelly at 25% of raw)",
    "varConfidence95": "number (default: 1.645)",
    "varConfidence99": "number (default: 2.326)",
    "maxDrawdownHalt": "number (default: 0.20 — halt positions above 20% drawdown)"
  },
  "hurst": {
    "window": "number (default: 100 — rolling periods for Hurst R/S calculation)"
  },
  "cache": {
    "ttlMs": "number (default: 1000 — feature vector cache TTL)"
  }
}
```

---

## Testing Strategy

- **Unit tests** (`*.test.ts` colocated): Each indicator/stat/risk function tested with hand-computed expected values from synthetic input arrays. Empty arrays, single-element, and under-lookback cases covered explicitly.
- **Integration test** (`test/*.integration.test.ts`): Mock pg returns 250 synthetic BTC/USDT 1m candles; mock MemDir returns synthetic tick and OB data; call `get_quant_features("BTC/USDT")`; assert all fields are non-null and within expected ranges.
- **Coverage target**: ≥70% lines/branches/functions (Vitest V8 threshold).
- **No live exchange calls** in any test — all external I/O is mocked.

---

## Rollout Dependencies

This plugin activates after market-data-ingestion has seeded ≥ 200 OHLCV candles. The gateway plugin activation order must list `market-data-ingestion` before `quant-math-engine` in the config (or the OHLCV DB query returns 0 rows and all indicators return null gracefully).
