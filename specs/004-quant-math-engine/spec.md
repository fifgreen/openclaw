# Feature Specification: Quantitative Math Engine

**Feature Branch**: `004-quant-math-engine`
**Created**: 2026-04-05
**Status**: Draft
**Scope**: Phase 3 of the trading bot roadmap (see `docs/trading-bot-roadmap.md`). This spec covers the pure-math computation layer: technical indicators derived from TimescaleDB OHLCV aggregates, live order flow analytics from tick and order book data, statistical models (realized volatility, Hurst exponent, correlation, regime detection), and risk mathematics (Kelly criterion, VaR, drawdown, position sizing). These are aggregated into a single typed `QuantFeatureVector` per symbol that is injected into every agent context window. It does NOT cover trade execution (Phase 5), vector embeddings (Phase 4), or sentiment signals (Phase 3 of roadmap / spec 003).
**Depends on**: `001-advanced-context-memory` (`@openclaw/trading-context` — MemDir/Redis), `002-market-data-ingestion` (`@openclaw/market-data-ingestion` — OHLCV, tick, OB data in MemDir + TimescaleDB)
**Package**: `extensions/quant-math-engine/` as `@openclaw/quant-math-engine`

---

## User Scenarios & Testing _(mandatory)_

### User Story 1 — Full Quant Feature Vector Available to the Trading Agent (Priority: P1)

As a trading agent, I need to call `get_quant_features("BTC/USDT")` and receive a single structured object combining all indicators, order flow metrics, statistical values, and risk parameters so I can make a single compound tool call instead of five separate calls per tick.

**Why this priority**: The feature vector is the primary input to every trading decision prompt. Without it, the agent must either chain multiple tool calls (adding latency) or reason from raw data (inaccurate and slow). Every other user story feeds into building this vector.

**Independent Test**: With market-data-ingestion running and seeded with 200 candles of synthetic BTC/USDT 1m data plus live tick/OB data, call `get_quant_features("BTC/USDT")`; verify the returned `QuantFeatureVector` is non-null and all numeric fields (EMA9, RSI, ATR, realizedVol, kellyPositionSize, obImbalance) are finite numbers within plausible ranges.

**Acceptance Scenarios**:

1. **Given** at least 200 OHLCV candles exist for `BTC/USDT` in TimescaleDB, **When** `get_quant_features("BTC/USDT")` is called, **Then** the returned vector includes all indicator fields (EMA9, EMA21, EMA50, EMA200, RSI, MACD, Bollinger, StochRSI, ADX), all stat fields (realizedVol, hurstExponent, regime), and all risk fields (var95, kellyPositionSize, maxPositionSize), all as finite numbers.
2. **Given** fewer than 26 OHLCV candles (insufficient for MACD), **When** `get_quant_features("BTC/USDT")` is called, **Then** the MACD fields are `null` and the response still succeeds (other indicators with shorter lookbacks are computed normally).
3. **Given** no tick/OB data in MemDir for the symbol, **When** `get_quant_features("BTC/USDT")` is called, **Then** order flow fields are `null` but the vector is still returned with indicator and stat fields populated.

---

### User Story 2 — Technical Indicators Per Timeframe (Priority: P1)

As a trading agent, I need to call `get_indicators("BTC/USDT", "15m")` and receive all computed indicators for that timeframe so I can assess trend direction and momentum before committing to an entry.

**Why this priority**: Indicators are the foundational technical inputs. The EMA alignment, RSI level, and MACD state are checked on every tick evaluation in the agent's system prompt examples.

**Independent Test**: Seed TimescaleDB with 250 BTC/USDT 1m candles aggregated into 15m buckets; call `get_indicators("BTC/USDT", "15m")`; verify `ema9 > ema21` reflects the seeded trend direction; verify `rsi` is between 0 and 100; verify `bollingerPosition` is between 0 and 1.

**Acceptance Scenarios**:

1. **Given** 250 1m candles, **When** `get_indicators("BTC/USDT", "15m")` is called, **Then** EMA9, EMA21, EMA50 are all computed (EMA200 may be `null` if fewer than 200 candles), RSI is 0–100, MACD histogram is a non-null finite number, and `bollingerPosition` is 0–1.
2. **Given** 14 1m candles only (exactly enough for RSI(14)), **When** `get_indicators("BTC/USDT", "1m")` is called, **Then** RSI returns a value, EMA21 is `null` (insufficient data), and MACD is `null` (insufficient data).
3. **Given** `timeframe: "1h"`, **When** `get_indicators("BTC/USDT", "1h")` is called, **Then** data is sourced from the `ohlcv_1h` aggregate view and indicators reflect the 1-hour timeframe correctly.

---

### User Story 3 — Live Order Flow Metrics (Priority: P1)

As a trading agent, I need to call `get_order_flow("BTC/USDT")` and receive real-time OB imbalance, CVD, spread Z-score, and large-trade activity so I can assess short-term market microstructure before entering a position.

**Why this priority**: Order flow is the microstructure layer that transforms a technically sound setup into a timing decision. OB imbalance above 0.60 significantly improves entry precision in the roadmap examples.

**Independent Test**: Inject synthetic tick events (60% buy-initiated, 40% sell-initiated over 100 ticks, 3 trades > $500K) and an OB snapshot (bid 62%, ask 38% top 5); call `get_order_flow("BTC/USDT")`; verify `tradeFlowBuyPct ≈ 0.60`, `obImbalance ≈ 0.62`, `largeTradeCount ≥ 3`.

**Acceptance Scenarios**:

1. **Given** 100 recent ticks (60 buy / 40 sell) in the rolling window, **When** `get_order_flow("BTC/USDT")` is called, **Then** `tradeFlowBuyPct` is 0.60 ± 0.02 and `cvdBtc` reflects cumulative net buyer volume.
2. **Given** an OB snapshot with 62% bid depth at top 5 levels, **When** `get_order_flow("BTC/USDT")` is called, **Then** `obImbalance` is 0.62 ± 0.01.
3. **Given** 3 trades > $500,000 in the last hour, **When** `get_order_flow("BTC/USDT")` is called, **Then** `largeTradeCount` is 3 and `largeTradeNetBias` is positive (net buy) or negative (net sell) accordingly.
4. **Given** spread history of [3.0, 3.1, 2.9, 4.2] USDT with rolling mean 3.05 and std 0.52, **When** the current spread is 4.2, **Then** `spreadZScore ≈ 2.2` indicating an abnormally wide spread.

---

### User Story 4 — Risk Parameters for Pre-Trade Validation (Priority: P2)

As a trading agent, I need to call `get_quant_features("BTC/USDT")` and use the `var95`, `kellyPositionSize`, `maxPositionSize`, and `currentDrawdown` fields to validate whether a proposed position size is within safe risk parameters before placing an order.

**Why this priority**: Risk management is the non-negotiable safety gate before any order is placed. Without these computed values the agent would need to calculate them inline from raw equity data, which is error-prone and outside the model's reliable math capability.

**Independent Test**: Given 30 trade outcomes (70% win rate, avg win +1.5%, avg loss -1.0%), call `get_quant_features("BTC/USDT")` and verify `kellyPositionSize = (0.7 × 0.015 - 0.3 × 0.010) / 0.015 = 0.50` (fractional Kelly at 0.25× → 0.125 BTC of 1 BTC capital = 12.5% exposure).

**Acceptance Scenarios**:

1. **Given** 30 trade history records (70% win, avg win 1.5%, avg loss 1.0%), 1 BTC account, **When** `get_quant_features("BTC/USDT")` is called, **Then** `kellyPositionSize` reflects the fractional Kelly position (bounded by `maxKellyFraction` config, default 0.25) and `var95` is a positive number representing 1-day 95% loss at risk.
2. **Given** realized volatility of 58% annualized, 95% confidence, **When** VaR is computed for a 1 BTC position, **Then** `var95` ≈ `realizedVol × 1/√252 × 1.645` (parametric daily VaR).
3. **Given** equity curve shows a current drawdown of 8%, **When** `get_quant_features("BTC/USDT")` is called, **Then** `currentDrawdown` is 0.08 and `maxPositionSize` is reduced proportionally (capped at 0 when drawdown exceeds configured `maxDrawdown`).

---

### User Story 5 — Regime Detection Informs Strategy Selection (Priority: P2)

As a trading agent, I need to know whether the market is in a trending or ranging regime so I can select the appropriate strategy type (trend-following vs. mean-reversion) and set confidence thresholds accordingly.

**Why this priority**: Using a trend-following strategy in a ranging market is one of the most common causes of consecutive losses in the roadmap examples. Regime detection provides an objective guard against this.

**Independent Test**: Seed 200 consecutive directional candles (simulating a strong uptrend) and compute Hurst exponent; verify H > 0.55 and `regime` is "trending". Then seed 200 mean-reverting candles (alternating +/-) and verify H < 0.45 and `regime` is "ranging".

**Acceptance Scenarios**:

1. **Given** 200 strongly directional (trending) price returns, **When** `get_quant_features("BTC/USDT")` is called, **Then** `hurstExponent > 0.55` and `regime` is `"trending"`.
2. **Given** 200 alternating (mean-reverting) price returns, **When** `get_quant_features("BTC/USDT")` is called, **Then** `hurstExponent < 0.45` and `regime` is `"ranging"`.
3. **Given** `hurstExponent` between 0.45 and 0.55, **When** `get_quant_features("BTC/USDT")` is called, **Then** `regime` is `"neutral"`.

---

## Non-Functional Requirements

- **NFR-001 Computation latency**: `get_quant_features` must return within 200 ms p99 when OHLCV data is already cached; DB query latency for 200 candles from TimescaleDB must be < 50 ms on a local deployment.
- **NFR-002 Graceful degradation**: If fewer candles are available than a given indicator's lookback, that indicator field is `null` rather than throwing. The vector is always structurally valid.
- **NFR-003 No floating-point explosions**: All returned numeric values must be finite (no `Infinity`, `-Infinity`, or `NaN`). Apply `Number.isFinite()` guards at the computation boundary.
- **NFR-004 Determinism**: Given the same OHLCV input series, all indicator computations must return the same result on every call (no RNG dependency in production code paths).
- **NFR-005 Logging**: `info`-level log on plugin activation and deactivation. `warn`-level log when a computation returns `null` due to insufficient data (rate-limited: at most once per symbol per minute to avoid log spam). No sensitive data (API keys, account balances) in computation logs.
- **NFR-006 No secrets in tool output**: Tool responses never include API credentials, raw account balances beyond what's needed for position sizing, or internal plugin state.
