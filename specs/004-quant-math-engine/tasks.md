# Tasks: Quantitative Math Engine

**Revised**: 2026-04-05
**Depends on**: `001-advanced-context-memory` (`@openclaw/trading-context` — MemDir/Redis), `002-market-data-ingestion` (`@openclaw/market-data-ingestion` — OHLCV in TimescaleDB, tick/OB in MemDir)
**Package**: `extensions/quant-math-engine/` as `@openclaw/quant-math-engine`

---

## Phase 1: Setup

**Purpose**: Scaffold the plugin package so all subsequent phases have a valid workspace package to build into.

- [x] T001 Initialize `extensions/quant-math-engine/` with `package.json` (`@openclaw/quant-math-engine`, ESM, `"type": "module"`), `openclaw.plugin.json` (plugin id `quant-math-engine`, display name, configSchema stub), `tsconfig.json` extending root config, and `src/` subdirectory tree (`schema/`, `db/`, `indicators/`, `orderflow/`, `stats/`, `risk/`, `feature-vector/`, `tools/`)
- [x] T002 [P] Create `index.ts` shell exporting a `definePluginEntry` stub and `runtime-api.ts` re-exporting `definePluginEntry`, `AnyAgentTool`, `OpenClawPluginApi`, `OpenClawPluginToolContext`, `OpenClawPluginToolFactory` from `openclaw/plugin-sdk/core`
- [x] T003 [P] Create `src/api.ts` public exports surface — re-exports `QuantFeatureVector` type, `IndicatorSet` type, `OrderFlowMetrics` type, `RiskMetrics` type; this is the only surface external plugins may import

---

## Phase 2: Schema

**Purpose**: Define the output shape of every computation as TypeScript types. No business logic yet — just the data contracts.

- [x] T004 Define `QuantFeatureVector` Zod schema and inferred type in `src/schema/QuantFeatureVector.ts` — all fields from plan.md Data Model; use `z.number().nullable()` for all computed fields (graceful degradation); `regime` field is a `z.enum(["trending", "ranging", "neutral"]).nullable()`; `macroRegime` defaults to `"neutral"` when unavailable
- [x] T005 [P] Write `src/schema/QuantFeatureVector.test.ts` — valid full vector parses without error; partial vector with all nulls parses without error; `regime` rejects an unknown string; numeric fields reject non-finite values (use `z.number().finite()`)

---

## Phase 3: DB Layer

**Purpose**: Read-only TimescaleDB access to fetch OHLCV candles for indicator computation.

- [x] T006 Implement lazy pg Pool singleton in `src/db/client.ts` — `getPool(url: string): Pool` (creates pool on first call, memoizes by URL), `closePool(): Promise<void>`, typed `query<T>(sql: string, params: unknown[]): Promise<T[]>` helper; follows the same pattern as `extensions/market-data-ingestion/src/db/client.ts`
- [x] T007 [P] Implement OHLCV query in `src/db/queries.ts` — `queryOHLCV(pool: Pool, symbol: string, timeframe: "1m" | "5m" | "1h", limit: number): Promise<OHLCVRow[]>` where `OHLCVRow = { timestamp: number; open: number; high: number; low: number; close: number; volume: number }`; selects from the appropriate continuous aggregate view (`ohlcv_1m`, `ohlcv_5m`, `ohlcv_1h`) created by `market-data-ingestion`; `ORDER BY timestamp ASC LIMIT $3`; validate numeric fields with `Number.isFinite` before returning, filtering out any corrupt rows
- [x] T008 [P] Write `src/db/queries.test.ts` — mock pg Pool; verify correct SQL emitted per timeframe (correct view name, correct ORDER BY, LIMIT applied); non-finite values filtered from result; empty result returns empty array

---

## Phase 4: Technical Indicators

**Purpose**: Pure functions that take OHLCV number arrays and return computed indicator values. All functions are deterministic and have no side effects.

- [x] T009 Implement `computeEMA(prices: number[], period: number): number | null` in `src/indicators/ema.ts` — returns `null` if `prices.length < period`; uses standard SMA seed for first EMA then applies EMA multiplier `k = 2 / (period + 1)`; final return is the last value in the EMA series over the input array
- [x] T010 [P] Implement `computeRSI(prices: number[], period: number): number | null` in `src/indicators/rsi.ts` — returns `null` if `prices.length < period + 1`; uses Wilder's smoothing (RMA); computes average gains and losses over the period and returns `100 - (100 / (1 + RS))`; clamps result to [0, 100]
- [x] T011 [P] Implement `computeMACD(prices: number[], fast: number, slow: number, signal: number): { macdLine: number; signalLine: number; histogram: number } | null` in `src/indicators/macd.ts` — returns `null` if `prices.length < slow + signal - 1`; MACD line = EMA(fast) - EMA(slow); signal line = EMA of MACD line; histogram = MACD - signal
- [x] T012 [P] Implement `computeBollinger(prices: number[], period: number, stdMultiplier: number): { upper: number; middle: number; lower: number; position: number } | null` in `src/indicators/bollinger.ts` — returns `null` if `prices.length < period`; middle = SMA(period); std = population std dev of last `period` prices; upper = middle + std × multiplier; lower = middle - std × multiplier; `position = (price - lower) / (upper - lower)` clamped to [0, 1]
- [x] T013 [P] Implement `computeStochRSI(prices: number[], period: number): number | null` in `src/indicators/stochastic-rsi.ts` — returns `null` if insufficient data for RSI + Stochastic window; computes RSI series over input, then applies Stochastic normalization `(RSI - minRSI) / (maxRSI - minRSI)` over the `period` window; returns [0, 1]
- [x] T014 [P] Implement `computeADX(ohlcv: OHLCVRow[], period: number): number | null` in `src/indicators/adx.ts` — returns `null` if `ohlcv.length < period × 2`; computes True Range, +DM, -DM; applies Wilder smoothing over `period`; returns ADX as a value [0, 100]
- [x] T015 [P] Implement `computeATR(ohlcv: OHLCVRow[], period: number): number | null` in `src/indicators/atr.ts` — returns `null` if `ohlcv.length < period + 1`; True Range = max(high-low, |high-prevClose|, |low-prevClose|); ATR = Wilder smoothed average of TR over period
- [x] T016 Write `src/indicators/indicators.test.ts` — unit tests for ALL indicator functions:
  - `computeEMA([1,2,3], 5)` returns null (insufficient data)
  - `computeEMA([1..20], 9)` returns a finite number
  - `computeRSI` with flat prices returns 50
  - `computeRSI` with all-up prices returns > 70
  - `computeMACD` returns null when `prices.length < slow + signal - 1`
  - `computeBollinger` position is 0.5 when price equals the middle band
  - `computeATR` for known OHLCV sequence matches hand-computed value within 0.001
  - Verify all functions return `null` on empty array input

---

## Phase 5: Order Flow Analytics

**Purpose**: Live microstructure metrics computed from recent tick and OB data read from MemDir. All functions accept plain arrays (decoupled from MemDir internals for testability).

- [x] T017 Implement `computeOBImbalance(bids: [number, number][], asks: [number, number][], depth: number): number` in `src/orderflow/imbalance.ts` — sums bid quantities at top `depth` levels and ask quantities at top `depth` levels; returns `bidQty / (bidQty + askQty)`; returns 0.5 if both sides are empty
- [x] T018 [P] Implement `computeCVD(ticks: Array<{ quantity: number; side: "buy" | "sell" }>, windowMs: number, now: number): number` in `src/orderflow/cvd.ts` — filters ticks to those within `windowMs` of `now`; returns `sum(buy qty) - sum(sell qty)` in base asset units
- [x] T019 [P] Implement `computeSpreadZScore(currentSpread: number, spreadHistory: number[]): number | null` in `src/orderflow/spread-zscore.ts` — returns `null` if `spreadHistory.length < 2`; computes running mean and population std dev of `spreadHistory`; returns `(currentSpread - mean) / std`; returns 0 if std = 0
- [x] T020 [P] Implement `computeTradeFlow(ticks: Array<{ quantity: number; side: "buy" | "sell"; timestamp: number }>, windowMs: number, now: number): { buyPct: number; totalVolume: number }` in `src/orderflow/trade-flow.ts` — filters to `windowMs` window; returns fraction of buy-side volume over total volume; returns `{ buyPct: 0.5, totalVolume: 0 }` when no ticks
- [x] T021 [P] Implement `detectLargeTrades(ticks: Array<{ quantity: number; side: "buy" | "sell"; price: number; timestamp: number }>, thresholdUsd: number, windowMs: number, now: number): { count: number; netBias: number }` in `src/orderflow/large-trades.ts` — filters to window; detects trades where `qty × price > thresholdUsd`; `netBias = sum(buy_qty) - sum(sell_qty)` of large trades only
- [x] T022 Write `src/orderflow/orderflow.test.ts` — unit tests for all order flow functions:
  - `computeOBImbalance` with equal bid/ask qty returns 0.5
  - `computeOBImbalance` with all bids returns 1.0
  - `computeCVD` with 60 buy / 40 sell ticks returns positive value
  - `computeSpreadZScore` with constant spread history returns 0
  - `computeSpreadZScore` returns null with < 2 spread history entries
  - `computeTradeFlow` with no ticks in window returns `{ buyPct: 0.5, totalVolume: 0 }`
  - `detectLargeTrades` counts only trades above USD threshold

---

## Phase 6: Statistical Models

**Purpose**: Higher-level statistical computations that require more data and are more expensive to compute. These are computed less frequently (pulled from DB, not from live MemDir tick stream).

- [x] T023 Implement `yangZhangVolatility(ohlcv: OHLCVRow[], period: number): number | null` in `src/stats/volatility.ts`
- [x] T024 [P] Implement `computeHurst(prices: number[], period: number): number | null` in `src/stats/hurst.ts`
- [x] T025 [P] Implement `rollingCorrelation(a: number[], b: number[], period: number): number | null` in `src/stats/correlation.ts`
- [x] T026 [P] Implement `detectRegime(hurst: number | null): "trending" | "ranging" | "neutral"` in `src/stats/regime.ts`
- [x] T027 Write `src/stats/stats.test.ts`
  - `yangZhangVolatility` with synthetic trending OHLCV returns a finite positive number
  - `yangZhangVolatility` returns null when `ohlcv.length < period + 1`
  - `computeHurst` with perfectly trending series (strictly monotone log-returns) returns H > 0.5
  - `computeHurst` with alternating log-returns returns H < 0.5
  - `rollingCorrelation([1..10], [1..10], 10)` returns 1.0
  - `rollingCorrelation([1..10], [10..1], 10)` returns -1.0
  - `detectRegime(0.62)` returns "trending"; `detectRegime(0.40)` returns "ranging"; `detectRegime(null)` returns "neutral"

---

## Phase 7: Risk Mathematics

**Purpose**: Position sizing and risk metrics that the trading agent uses as pre-trade validation gates.

- [x] T028 Implement `kellyFraction(winRate: number, avgWinPct: number, avgLossPct: number): number` in `src/risk/kelly.ts`
- [x] T029 [P] Implement `parametricVaR(annualizedVol: number, confidence: number, horizonDays: number): number` in `src/risk/var.ts`
- [x] T030 [P] Implement `computeDrawdown(equityCurve: number[]): { current: number; max: number }` in `src/risk/drawdown.ts`
- [x] T031 [P] Implement `computeMaxPositionSize(params: { kellyFraction: number; var95: number; accountEquity: number; currentDrawdown: number; cfg: RiskConfig }): number` in `src/risk/position-size.ts`
- [x] T032 Write `src/risk/risk.test.ts`
  - `kellyFraction(0.7, 0.015, 0.010)` returns ≈ 0.50 (within 0.001)
  - `kellyFraction(0.3, 0.01, 0.02)` returns 0 (negative Kelly → clamped)
  - `parametricVaR(0.48, 1.645, 1)` returns ≈ 0.0497 (within 0.001)
  - `computeDrawdown([100, 110, 90, 95])` → current ≈ 0.136, max ≈ 0.182
  - `computeMaxPositionSize` with drawdown > `maxDrawdownHalt` returns 0
  - `computeMaxPositionSize` returns min of Kelly and VaR cap

---

## Phase 8: Feature Vector Builder and Cache

**Purpose**: Assemble all computed values into a single `QuantFeatureVector` with 1-second TTL cache to prevent redundant computation within the same tick interval.

- [x] T033 Implement `buildQuantFeatureVector(symbol: string, ohlcv: OHLCVRow[], ticks: PriceTick[], obSnapshot: OrderBookSnapshot | null, spreadHistory: number[], cfg: QuantConfig): QuantFeatureVector` in `src/feature-vector/builder.ts`
- [x] T034 [P] Implement simple in-process TTL cache in `src/feature-vector/cache.ts`
- [x] T035 [P] Write `src/feature-vector/feature-vector.test.ts`

---

## Phase 9: Tool Handlers

**Purpose**: Wrap computation functions in OpenClaw tool registration objects. Tools read from DB and MemDir, build the feature vector, and return results.

- [x] T036 Implement `buildGetIndicatorsTool(deps: ToolDeps)` in `src/tools/get-indicators.ts`
- [x] T037 [P] Implement `buildGetOrderFlowTool(deps: ToolDeps)` in `src/tools/get-order-flow.ts`
- [x] T038 [P] Implement `buildGetQuantFeaturesTool(deps: ToolDeps)` in `src/tools/get-quant-features.ts`

---

## Phase 10: Plugin Entry + Tool Registration

**Purpose**: Wire all components into the OpenClaw plugin lifecycle, register tools, and complete the `definePluginEntry` implementation.

- [x] T039 Register all 3 tools in `index.ts` via `definePluginEntry` using `openclaw/plugin-sdk/core`
- [x] T040 [P] Populate `openclaw.plugin.json` `configSchema` with all overridable knobs
- [x] T041 Complete `index.ts` `definePluginEntry` implementation

---

## Phase 11: Integration Tests

**Purpose**: End-to-end validation that the full pipeline from DB → computation → tool response works correctly.

- [x] T042 Write integration test in `test/quant-math-engine.integration.test.ts`
- [x] T043 [P] Integration test: call `get_indicators("BTC/USDT", "1m")` with mocked OHLCV
- [x] T044 [P] Integration test graceful degradation with empty data sources
- [x] T045 [P] Integration test: verify 1-second cache call count

---

## Dependencies

```
Phase 1 (Setup)
  └─► Phase 2 (Schema)
        └─► Phase 3 (DB Layer)
              ├─► Phase 4 (Technical Indicators — pure functions, no DB dependency)
              ├─► Phase 5 (Order Flow Analytics — pure functions, no DB dependency)
              ├─► Phase 6 (Statistical Models — pure functions, no DB dependency)
              └─► Phase 7 (Risk Mathematics — pure functions, no DB dependency)
                    └─► Phase 8 (Feature Vector Builder + Cache — depends on all computation phases)
                          └─► Phase 9 (Tool Handlers — wraps builder in OpenClaw tool API)
                                └─► Phase 10 (Plugin Entry — wires all tools into plugin lifecycle)
                                      └─► Phase 11 (Integration Tests)
```

**Within Phase 4–7**: All indicator/stats/risk tasks can be developed in parallel — they are pure functions with no cross-dependencies.

## Parallel Execution Examples

- T009, T010, T011, T012, T013, T014, T015 can run in parallel (independent indicator files)
- T017, T018, T019, T020, T021 can run in parallel (independent order flow files)
- T023, T024, T025, T026 can run in parallel (independent stats files)
- T028, T029, T030, T031 can run in parallel (independent risk files)
- T042, T043, T044, T045 can run in parallel (independent integration tests)

## Implementation Strategy

**MVP scope** (deliver US1 end-to-end first):

1. T001–T003 (setup)
2. T004–T005 (schema)
3. T006–T008 (DB layer)
4. T009, T010 (EMA + RSI — minimum for meaningful EMA alignment check)
5. T017 (OB imbalance — most impactful order flow metric)
6. T023, T024, T026 (Yang-Zhang vol + Hurst + regime — for regime gate)
7. T028, T029, T031 (Kelly + VaR + position sizing)
8. T033, T034 (feature vector builder + cache)
9. T038, T039, T041 (get_quant_features tool + plugin entry)

After MVP: complete remaining indicators (T011–T015), remaining order flow (T018–T021), remaining stats (T025), remaining risk (T030), all unit tests, then integration tests.
