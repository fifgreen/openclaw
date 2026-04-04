---
title: "Trading Bot Roadmap"
description: "Roadmap for a professional AI trading bot on OpenClaw — real-time market ingestion, sentiment & geoeconomic intelligence, quantitative math layer, vector-RAG decisions, and continuous fine-tuning from trade history."
---

# Trading Bot Roadmap

A professional, self-improving crypto trading system built on OpenClaw. It combines real-time market microstructure data, sentiment analysis, geoeconomic macro signals, and a quantitative math layer — all embedded into a vector store for RAG-driven decisions. The agent executes trades through direct exchange WebSocket APIs, journals every decision, and continuously improves. Supports two LLM provider modes — **local-only** (Qwen 3.5 via Ollama with self-fine-tuning) or **hybrid** (Claude API for high-stakes reasoning + local Qwen for high-frequency ticks) — selectable via OpenClaw's provider config with zero code changes.

---

## Architecture Overview

```
                        ┌─────────────────────────────────────────┐
                        │           EXTERNAL DATA SOURCES          │
                        ├──────────┬────────────┬─────────────────┤
                        │ Binance  │   Bybit    │  Sentiment &    │
                        │ WS API   │   WS API   │  Macro Feeds    │
                        └────┬─────┴─────┬──────┴───────┬─────────┘
                             │           │              │
                             ▼           ▼              ▼
              ┌──────────────────────────────────────────────────┐
              │          INGESTION LAYER (BullMQ-gated)          │
              │                                                  │
              │  ┌────────────────┐  ┌────────────────────────┐  │
              │  │ Market Ingest  │  │  Sentiment & Macro     │  │
              │  │ Price ticks    │  │  News, social, Fear &  │  │
              │  │ OB deltas      │  │  Greed, CPI, rates,    │  │
              │  │ Funding rates  │  │  sanctions, oil, DXY   │  │
              │  └───────┬────────┘  └───────────┬────────────┘  │
              └──────────┼───────────────────────┼───────────────┘
                         │                       │
                         ▼                       ▼
              ┌──────────────────────────────────────────────────┐
              │          QUANTITATIVE MATH ENGINE                │
              │                                                  │
              │  Technical indicators (RSI, MACD, Bollinger)     │
              │  Order flow metrics (VWAP, OB imbalance, CVD)    │
              │  Statistical models (volatility, Z-score, Hurst) │
              │  Risk math (Kelly, VaR, Sharpe, max drawdown)    │
              └───────────────────────┬──────────────────────────┘
                                      │
                                      ▼
              ┌──────────────────────────────────────────────────┐
              │      EMBEDDING + VECTOR STORE (pgvector)         │
              │                                                  │
              │  Market state chunks + quant features            │
              │  Sentiment snapshots + macro context              │
              │  Outcome annotations (profit/loss/neutral)       │
              │                                                  │
              │  nomic-embed-text via Ollama → pgvector           │
              └───────────────────────┬──────────────────────────┘
                                      │
                                      ▼
              ┌──────────────────────────────────────────────────┐
              │     TRADING AGENT (configurable LLM provider)    │
              │                                                  │
              │  RAG: query similar setups + sentiment + macro   │
              │  Quant features injected into context            │
              │  Structured JSON decision output                 │
              │  Risk management gate (Kelly, VaR, position cap) │
              └──────────┬───────────────────────┬───────────────┘
                         │                       │
              ┌──────────┼───────────────────────┼───────────────┐
              │          │  STRATEGY LIFECYCLE    │               │
              │          │                       │               │
              │  hypothesis ──► backtest ──► testnet ──► live    │
              │       ▲           │  fail       │  fail    │     │
              │       │           ▼             ▼          │     │
              │       └────── mutate/drop    drop          │     │
              │                                   ◄── demote ◄──┘│
              │  Agent evaluates at every stage — self-improving │
              └──────────┬───────────────────────┬───────────────┘
                         │                       │
                         ▼                       ▼
              ┌─────────────────────┐  ┌────────────────────────┐
              │  ORDER EXECUTION    │  │   TRADE JOURNAL        │
              │  Direct WS API      │  │   Append-only JSONL    │
              │  Binance + Bybit   │  │   Full decision context │
              │  BullMQ rate limit  │  │   Outcome enrichment   │
              └─────────────────────┘  └───────────┬────────────┘
                                                   │
                                                   ▼
              ┌──────────────────────────────────────────────────┐
              │        FINE-TUNING PIPELINE                      │
              │                                                  │
              │  Export profitable trades → Chat JSONL            │
              │  Local: unsloth fine-tune → GGUF → Ollama        │
              │  Hybrid: Claude API (strategy) + local (ticks)    │
              │  A/B eval against base model → auto-promote      │
              └──────────────────────────────────────────────────┘
```

---

## Phase 1 — Market Data Ingestion

**Goal**: Reliable, rate-limited, real-time feed of price ticks, order book snapshots, and funding rates from Binance and Bybit into TimescaleDB.

### Tasks

- [ ] **1.1 — Exchange WebSocket Adapters** (`packages/trading/ingestion/`)
  - `BinanceAdapter` — connect to `@trade`, `@depth@100ms`, `@markPrice` streams (Spot + USDT-M Futures)
  - `BybitAdapter` — connect to `trade`, `orderbook.50`, `tickers` streams (Spot + Linear)
  - Adapter interface: `connect()`, `disconnect()`, `subscribe(symbols)`, `onTick(cb)`, `onOBDelta(cb)`
  - Automatic reconnect with exponential backoff (base 1s, max 30s, jitter)
  - Per-connection heartbeat/ping-pong with dead-connection detection (>10s silence → reconnect)

- [ ] **1.2 — Normalized Event Schema**

```typescript
interface PriceTick {
  exchange: "binance" | "bybit";
  symbol: string; // Unified: "BTC/USDT"
  price: number;
  quantity: number;
  side: "buy" | "sell";
  tradeId: string;
  timestamp: number; // Unix ms, exchange time
  localTimestamp: number; // Unix ms, receipt time (for latency tracking)
}

interface OrderBookSnapshot {
  exchange: "binance" | "bybit";
  symbol: string;
  bids: [number, number][]; // [price, qty][] — sorted desc
  asks: [number, number][]; // [price, qty][] — sorted asc
  depth: number; // number of levels
  sequenceId: number; // exchange sequence for gap detection
  timestamp: number;
}

interface FundingRate {
  exchange: "binance" | "bybit";
  symbol: string;
  rate: number; // e.g. 0.0001 = 0.01%
  nextFundingTime: number;
  timestamp: number;
}
```

- [ ] **1.3 — Order Book State Machine**
  - Maintain full local OB per symbol from initial snapshot + incremental deltas
  - Sequence gap detection → automatic re-snapshot on gap
  - Expose: `getTopOfBook(symbol)`, `getMidprice(symbol)`, `getSpread(symbol)`, `getImbalance(symbol, depth)`
  - Configurable depth: top 5 (default for decisions), top 20 (for analytics)

- [ ] **1.4 — TimescaleDB Persistence**
  - Hypertables: `price_ticks`, `ob_snapshots` (sampled every N seconds, not every delta), `funding_rates`
  - Continuous aggregates: 1m / 5m / 1h OHLCV candles auto-computed from `price_ticks`
  - Retention policy: raw ticks 7 days, 1m candles 90 days, 1h candles indefinite
  - Batch insert with write buffer (flush every 500ms or 1000 rows, whichever first)
  - Backpressure: if write queue > 10k events, drop older ticks (log warning), never drop OB snapshots

- [ ] **1.5 — BullMQ Rate Limiter**
  - One BullMQ queue per exchange: `trading:ratelimit:binance`, `trading:ratelimit:bybit`
  - All outbound REST API calls (order placement, account queries) go through the queue
  - Rate limit config per exchange (Binance: 1200 req/min, Bybit: 600 req/min) with 80% safety margin
  - WebSocket connections are NOT rate-limited (they are push-only), only REST calls

- [ ] **1.6 — Historical Data Bootstrap** (`packages/trading/ingestion/bootstrap.ts`)
  - On first deployment (empty TimescaleDB), seed historical data from exchange REST APIs:
    - Binance: `GET /api/v3/klines` (Spot) + `GET /fapi/v1/klines` (Futures) — up to 1000 candles per request
    - Bybit: `GET /v5/market/kline` — up to 1000 candles per request
  - Fetch last 90 days of 1m candles per configured symbol (required for first backtest run)
  - Fetch last 90 days of funding rate history: Binance `GET /fapi/v1/fundingRate`, Bybit `GET /v5/market/funding/history`
  - Insert into TimescaleDB hypertables + trigger continuous aggregate refresh
  - Rate-limited through the same BullMQ queues (Phase 1.5) — bootstrap runs at 50% of normal rate to avoid bans
  - Idempotent: skip already-populated time ranges (check `max(timestamp)` per symbol before fetching)
  - CLI: `openclaw trading bootstrap --symbols BTC/USDT,ETH/USDT --days 90`
  - Note: raw tick data is NOT available historically via REST — only candles and funding rates. Order flow analytics (OB imbalance, CVD, whale detection) are only available from live tick data going forward. Backtests on historical data will use candle-based indicators only (see Phase 5.10 note).

### Deliverables

- `packages/trading/ingestion/` — adapters, OB state machine, persistence, rate limiter, bootstrap
- Config: `ingestion.exchanges[]`, `ingestion.symbols[]`, `ingestion.obDepth`, `ingestion.retentionDays`

---

## Phase 2 — Sentiment & Geoeconomic Intelligence

**Goal**: Continuously ingest non-price signals that move crypto markets — social sentiment, news, macroeconomic indicators, and geopolitical events — and embed them alongside market data for richer RAG context.

### Tasks

- [ ] **2.1 — Crypto Sentiment Feeds** (`packages/trading/sentiment/`)
  - **Fear & Greed Index**: poll `alternative.me/crypto/fear-and-greed-index/` every 4h, store score + classification
  - **Crypto Twitter/X sentiment**: use a lightweight sentiment classifier on top-N influencer feeds (via RSS or scraper)
    - Classify: bullish / bearish / neutral with confidence score
    - Aggregate per symbol: weighted sentiment score over trailing 1h / 4h / 24h windows
  - **Reddit r/CryptoCurrency**: poll top posts every 30min, extract mentioned tickers + sentiment
  - **Funding rate sentiment**: derive long/short bias from funding rate sign and magnitude (already ingested in Phase 1)

- [ ] **2.2 — News & Event Feed**
  - Ingest headlines from crypto news APIs (CryptoPanic, CoinGecko news)
  - NLP classification via Qwen 3.5 (or a smaller local model):
    - Event type: `regulatory`, `hack`, `partnership`, `listing`, `macro`, `technical`
    - Impact: `high`, `medium`, `low`
    - Affected symbols: extracted ticker list
  - Store in TimescaleDB: `news_events` table (headline, source, classification, symbols, timestamp)

- [ ] **2.3 — Geoeconomic Macro Layer**
  - **Scheduled data pulls** (BullMQ cron jobs):
    - US CPI, PPI, NFP, FOMC decisions → FRED API (free, `api.stlouisfed.org`)
    - DXY (Dollar Index) → daily close via free forex API
    - US 10Y Treasury yield → FRED
    - Oil (WTI) price → daily
    - Global M2 money supply → monthly
    - Sanctions / trade war events → curated RSS + manual flag
  - **Macro regime classifier**: derive a simple regime state from combinations:
    - `risk-on` (falling DXY, dovish Fed, rising M2)
    - `risk-off` (rising DXY, hawkish Fed, falling equities)
    - `neutral` (mixed signals)
  - Store as `macro_snapshots` in TimescaleDB (daily granularity)

- [ ] **2.4 — Sentiment Embedding**
  - Serialize each sentiment + macro snapshot into a text chunk:

```
Sentiment Snapshot @ 2026-03-29T14:00Z
Fear & Greed: 72 (Greed) | 24h change: +8
BTC Twitter sentiment (4h): 0.64 bullish | volume: 12,400 tweets
ETH Twitter sentiment (4h): 0.51 neutral | volume: 3,200 tweets
Top news: "SEC approves spot ETH options" (regulatory, high impact)
Macro: risk-on | DXY: 101.2 (-0.3%) | US10Y: 4.12% | Oil: $78.4
FOMC: next meeting in 18 days | last action: hold
Funding rates: BTC +0.012% (mild long bias) | ETH +0.008% (neutral)
```

- Embed with `nomic-embed-text` and store in pgvector alongside market state vectors
- Tag with metadata: `{ type: "sentiment", timestamp, symbols[], regime }`

- [ ] **2.5 — Feed Verification & Data Quality** (`packages/trading/sentiment/health.ts`)
  - **Per-feed health monitor** (BullMQ cron, every 5 min):
    - Track `last_successful_fetch`, `last_error`, `consecutive_errors`, `avg_latency_ms` per feed
    - **Staleness thresholds** (configurable per feed type):
      - Fear & Greed: stale if > 6h since last update (normally updates daily)
      - Twitter/Reddit sentiment: stale if > 2h
      - CryptoPanic news: stale if > 1h
      - FRED macro data (CPI, yields, M2): stale if > 48h past scheduled release date
      - DXY / Oil: stale if > 26h (daily close + buffer)
    - Feed status enum: `healthy` | `degraded` (1–3 consecutive errors) | `stale` (past threshold) | `dead` (>10 consecutive errors)
  - **Data freshness validation**:
    - Every ingested data point tagged with `fetchedAt` (local) + `sourceTimestamp` (from API) — reject if `sourceTimestamp` is older than previous stored value (duplicate/replay protection)
    - FRED release calendar awareness: flag CPI/NFP as "expected but missing" if past scheduled release date + 4h
    - Detect frozen feeds: if a numeric value (e.g., Fear & Greed score) hasn't changed in > 3× its normal update frequency, flag as potentially frozen
  - **Cross-source divergence detection**:
    - Compare sentiment signals that should roughly agree:
      - Fear & Greed vs. Twitter aggregate sentiment: flag if divergence > 2σ from historical norm
      - Funding rate bias vs. social sentiment direction: log divergences (informational, not blocking)
    - When divergence detected: inject a `divergence_warning` field into the sentiment snapshot before embedding — the agent sees the conflict and can reason about it
    - Do NOT auto-resolve conflicts — the agent's confluence framework already handles mixed signals
  - **Historical accuracy scoring** (weekly BullMQ cron):
    - Retroactively score each sentiment signal against actual price movement:
      - For each past sentiment snapshot, compare predicted direction (bullish/bearish/neutral) with actual 4h/24h price change
      - Compute per-feed accuracy rate over trailing 30 days
      - Store in `feed_accuracy_scores` table (feed_name, period, accuracy_pct, sample_size)
    - Used by the agent: `get_feed_accuracy()` tool returns confidence weights per feed — agent can downweight feeds that have been historically inaccurate
    - If a feed's 30-day accuracy drops below 40% (worse than random), auto-demote to `degraded` and alert user
  - **Backfill on recovery**:
    - When a feed recovers from `dead` → `healthy`:
      - Attempt to backfill missed data points from the API (most APIs support historical queries within limits)
      - For feeds that don't support backfill (e.g., Twitter real-time): log a gap marker in TimescaleDB, embed a "data gap" note in affected sentiment snapshots
      - Do NOT retroactively re-embed old snapshots — only backfill raw data; future embeddings will use fresh data
  - **Alerting** (via OpenClaw channels):
    - `⚠️ Feed degraded: Twitter sentiment — 3 consecutive errors (rate limit?)`
    - `🔴 Feed dead: CryptoPanic — 12 consecutive errors, last success 2h ago`
    - `📊 Feed accuracy report: Fear & Greed 30d accuracy 71%, Twitter 58%, Reddit 43% (below threshold)`
    - `✅ Feed recovered: FRED API — backfilled 3 missing CPI data points`
    - Weekly digest: all feed statuses, accuracy scores, any extended gaps

### Deliverables

- `packages/trading/sentiment/` — feeds, classifiers, serializer, health monitor, accuracy scorer
- Config: `sentiment.enabled`, `sentiment.feeds[]`, `sentiment.pollIntervals`, `macro.fredApiKey`, `sentiment.stalenessThresholds`, `sentiment.accuracyMinPct`, `sentiment.divergenceAlertSigma`

---

## Phase 3 — Quantitative Math Engine

**Goal**: A pure-math layer that computes technical indicators, statistical features, and risk metrics from raw market data. These features are injected into every agent context window and used for pre-trade validation.

### Tasks

- [ ] **3.1 — Technical Indicators** (`packages/trading/quant/indicators.ts`)
  - Computed from TimescaleDB continuous aggregates (OHLCV candles):
    - **Trend**: EMA(9), EMA(21), EMA(50), EMA(200), MACD(12,26,9), ADX(14)
    - **Momentum**: RSI(14), Stochastic RSI, Williams %R, CCI(20)
    - **Volatility**: Bollinger Bands(20,2), ATR(14), historical volatility (30d annualized)
    - **Volume**: OBV, VWAP (session), CVD (cumulative volume delta from tick data)
  - All indicators computed on multiple timeframes: 1m, 5m, 15m, 1h, 4h, 1d
  - Expose: `getIndicators(symbol, timeframe)` → typed object with all values

- [ ] **3.2 — Order Flow Analytics** (`packages/trading/quant/orderflow.ts`)
  - From raw tick and OB data:
    - **Order book imbalance**: bid_qty / (bid_qty + ask_qty) at top N levels
    - **Trade flow imbalance**: buy_volume / total_volume over trailing window
    - **Large trade detection**: flag trades > 2σ above mean size (potential whale activity)
    - **Spread Z-score**: current spread vs. trailing 1h mean — detects unusual tightening/widening
    - **Absorption detection**: large resting orders that absorb incoming market orders without price movement

- [ ] **3.3 — Statistical Models** (`packages/trading/quant/stats.ts`)
  - **Realized volatility**: Yang-Zhang estimator (OHLC-based, more accurate than close-to-close)
  - **Hurst exponent**: rolling 100-bar estimate — H > 0.5 indicates trending, H < 0.5 mean-reverting
  - **Z-score of price**: (price - μ) / σ over trailing N bars — for mean-reversion signals
  - **Correlation matrix**: Rolling 30d Pearson correlation between tracked pairs (BTC, ETH, SOL, etc.)
  - **Regime detection**: Hidden Markov Model (2-state: trending/ranging) fitted on returns + volatility

- [ ] **3.4 — Risk Mathematics** (`packages/trading/quant/risk.ts`)
  - **Kelly criterion**: optimal position size = (win_rate × avg_win - (1 - win_rate) × avg_loss) / avg_win
    - Applied with fractional Kelly (0.25×) for safety
    - Computed from trailing 100 trades
  - **Value at Risk (VaR)**: 95th percentile max loss over 1-day horizon (historical simulation from tick data)
  - **Sharpe ratio**: rolling 30d, annualized — used for model evaluation
  - **Maximum drawdown**: current and historical peak-to-trough — hard circuit breaker at configurable threshold
  - **Position sizing**: combines Kelly, VaR, and account equity to output max safe position size per trade

- [ ] **3.5 — Quant Feature Vector**
  - Aggregate all indicators + stats + risk metrics into a single typed object per symbol:

```typescript
interface QuantFeatureVector {
  symbol: string;
  timestamp: number;
  // Trend
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  macd: { line: number; signal: number; histogram: number };
  adx: number;
  // Momentum
  rsi14: number;
  stochRsi: number;
  // Volatility
  bollingerPosition: number; // 0 = lower band, 1 = upper band
  atr14: number;
  realizedVol30d: number;
  // Order flow
  obImbalance: number; // -1 to +1
  tradeFlowImbalance: number; // -1 to +1
  cvd1h: number;
  // Statistical
  hurstExponent: number;
  priceZScore: number;
  regime: "trending" | "ranging";
  // Risk
  kellyFraction: number;
  var95_1d: number;
  sharpe30d: number;
  maxDrawdownCurrent: number;
  maxPositionSize: number;
  // Sentiment (from Phase 2)
  fearGreedIndex: number;
  sentimentScore: number; // -1 to +1
  macroRegime: "risk-on" | "risk-off" | "neutral";
}
```

- Serialized both as:
  - **Structured JSON** → injected directly into agent tool responses
  - **Human-readable text** → embedded into vector store for RAG retrieval

### Deliverables

- `packages/trading/quant/` — indicators, order flow, stats, risk, feature vector
- Config: `quant.indicatorTimeframes[]`, `quant.hurstWindow`, `quant.kellyFraction`, `quant.varConfidence`

---

## Phase 4 — Embedding & Vector Store

**Goal**: Embed all signal types (market state, quant features, sentiment, macro) into pgvector for unified semantic retrieval by the trading agent.

### Tasks

- [ ] **4.1 — Multi-Signal Serializer** (`packages/trading/vector/serializer.ts`)
  - Combine market state + quant features + sentiment into a single composite text chunk per tick interval:

```
═══ BTC/USDT Market State @ 2026-03-29T14:23:00Z ═══

PRICE: 83,420.50 | 1m: +0.34% | 1h: +1.2% | 24h: +3.8%
Bid/Ask: 83,419.0 / 83,422.0 | Spread: 3.0 (Z: -0.42 — normal)
OB Imbalance (top 5): Bid 62% / Ask 38% — bullish pressure
Trade Flow (5m): 58% buy | CVD(1h): +142 BTC — accumulation
Large trades (1h): 3 buys > $500K, 1 sell > $500K

INDICATORS (15m):
EMA: 9 > 21 > 50 (bullish alignment) | Price above EMA200
RSI(14): 61.2 — neutral, not overbought
MACD: +12.4 (histogram expanding) | ADX: 28.3 (trending)
Bollinger: 0.72 (upper half, room to move)
Hurst(100): 0.63 — trending regime confirmed

VOLATILITY & RISK:
ATR(14): 1,245 | Realized Vol(30d): 48% annualized
VaR(95%, 1d): -4.2% | Max drawdown (current): -1.8%
Kelly position: 0.032 BTC | Max safe size: 0.05 BTC

SENTIMENT:
Fear & Greed: 72 (Greed, +8 from yesterday)
Twitter(4h): 0.64 bullish (12,400 tweets)
Top event: "SEC approves spot ETH options" (regulatory, high)
Funding: +0.012% (mild long bias — not overcrowded)

MACRO:
Regime: risk-on | DXY: 101.2 (-0.3%) | US10Y: 4.12%
Next FOMC: 18 days | Last action: hold
```

- [ ] **4.2 — Embedding Pipeline**
  - `nomic-embed-text` via Ollama (768-dim vectors)
  - Embed composite chunks every 30s per symbol (configurable)
  - Batch processing: up to 8 chunks per Ollama request
  - Async pipeline: serializer → embedding queue (BullMQ) → pgvector insert

- [ ] **4.3 — pgvector Schema & Indexing**

```sql
CREATE TABLE market_embeddings (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL,
  exchange    TEXT NOT NULL,
  timestamp   TIMESTAMPTZ NOT NULL,
  embedding   vector(768) NOT NULL,
  chunk_text  TEXT NOT NULL,
  -- Structured metadata for filtered queries
  rsi14       REAL,
  regime      TEXT,           -- 'trending' | 'ranging'
  sentiment   REAL,           -- -1 to +1
  macro_regime TEXT,          -- 'risk-on' | 'risk-off' | 'neutral'
  -- Outcome annotation (filled after trade resolves)
  trade_id    UUID,
  outcome     TEXT,           -- 'profit' | 'loss' | 'neutral'
  pnl_pct     REAL
);

CREATE INDEX ON market_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ON market_embeddings (symbol, timestamp DESC);
```

- `queryRecentContext(symbol, k, filters?)` — cosine similarity search with optional metadata filters (e.g., only trending regime, only profitable outcomes)
- `querySimilarSetups(symbol, k)` — retrieve top-k most similar past market states that led to trades, with their outcomes

- [ ] **4.4 — Outcome Annotation**
  - On trade close (TP/SL/manual): update `market_embeddings` rows linked to that trade with `outcome` + `pnl_pct`
  - This creates an outcome-aware vector store: "find me past situations that looked like now AND were profitable"

- [ ] **4.5 — pgvector Index Maintenance**
  - IVFFlat indexes degrade as data grows beyond the initial training set (~14.4K embeddings/day from 5 pairs × 30s ticks → ~1.3M rows after 90 days)
  - Weekly `REINDEX` job via BullMQ cron: `REINDEX INDEX CONCURRENTLY market_embeddings_embedding_idx;` (non-blocking)
  - Monitor recall quality: sample 100 known-good queries weekly, alert if avg recall drops below 95%
  - If table exceeds ~5M rows, evaluate switching to HNSW index (`ef_construction=128, m=16`) for better recall at scale

### Deliverables

- `packages/trading/vector/` — serializer, embedding pipeline, pgvector integration
- Config: `vector.embeddingIntervalMs`, `vector.embeddingBatchSize`, `vector.ivfflatLists`, `vector.reindexCronSchedule`

---

## Phase 5 — Trading Agent & Strategy Creator

**Goal**: An OpenClaw agent powered by Qwen 3.5 that synthesizes market data, quant features, sentiment, and macro context through RAG to make and execute trading decisions — driven by user-defined strategies that can be tested before going live.

### Tasks

- [ ] **5.1 — Agent Tools** (`packages/trading/agent/tools/`)

| Tool                                                     | Description                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `get_market_snapshot(symbol)`                            | Live price, spread, OB state, funding rate                                   |
| `get_quant_features(symbol)`                             | Full `QuantFeatureVector` — indicators, stats, risk metrics                  |
| `query_similar_setups(symbol, k)`                        | RAG: top-k historically similar market states with outcomes                  |
| `get_sentiment(symbol?)`                                 | Current sentiment scores, Fear & Greed, top news event                       |
| `get_feed_accuracy()`                                    | Per-feed 30-day accuracy scores — agent uses to weight signal confidence     |
| `get_macro_context()`                                    | Macro regime, DXY, yields, upcoming events (FOMC, CPI)                       |
| `get_open_positions()`                                   | Current portfolio: positions, entry price, unrealised P&L                    |
| `get_account_balance()`                                  | Available capital per asset, margin usage                                    |
| `place_order(symbol, side, type, qty, price?, sl?, tp?)` | Submit order via exchange WS API                                             |
| `cancel_order(orderId)`                                  | Cancel open order                                                            |
| `get_trade_history(symbol, limit)`                       | Recent bot trades with outcomes                                              |
| `compute_position_size(symbol, confidence)`              | Kelly + VaR → recommended size                                               |
| `create_strategy(strategy)`                              | Agent submits a new `TradingStrategy` JSON — validated + queued for backtest |
| `mutate_strategy(id, changes)`                           | Tweak parameters of a dropped/weak strategy → new version                    |
| `evaluate_backtest(strategyId)`                          | Run 90-day backtest, return metrics + agent assessment                       |
| `evaluate_testnet(strategyId)`                           | Compare testnet metrics vs backtest expectations → promote/extend/drop       |
| `get_testnet_report(strategyId)`                         | Daily testnet performance summary for a running strategy                     |
| `evaluate_live_strategy(strategyId)`                     | Rolling 7d/30d live metrics for ongoing monitoring                           |
| `list_strategies(status?)`                               | List strategies filtered by lifecycle status                                 |
| `drop_strategy(id, reason)`                              | Drop a strategy with written failure analysis (stored in vector DB)          |

- [ ] **5.2 — System Prompt**
  - Role: professional quantitative trader with expertise in crypto market microstructure
  - **Strategy injection**: The active `TradingStrategy` JSON is loaded into the system prompt at session start. The agent sees the full strategy rules (entry conditions, exit rules, risk parameters, direction) and must follow them. When the agent operates under `btc-trend-follower-v4`, it sees that strategy's `entry.trend.emaAlignment: "bullish"`, `entry.momentum.rsiRange: [30, 70]`, `exit.takeProfitAtr: 2.0`, `direction: "long"`, etc. The generic confluence framework is the fallback for when no strategy-specific rules override it.
  - **Decision framework** (enforced in prompt):
    1. Always call `get_quant_features` + `get_sentiment` + `get_macro_context` first
    2. Call `query_similar_setups` to ground decision in historical outcomes
    3. Apply strategy entry conditions first; then apply confluence scoring (minimum alignment from strategy's `confluenceMin` signal groups)
    4. Only open positions in the strategy's allowed `direction` — a `"long"`-only strategy MUST NOT short, and vice versa
    5. Call `compute_position_size` before any order — never exceed the returned max OR the strategy's `risk.maxPositionPct`
    6. Output structured JSON decision:

```json
{
  "action": "buy" | "sell" | "hold",
  "symbol": "BTC/USDT",
  "quantity": 0.032,
  "order_type": "limit" | "market",
  "limit_price": 83410.00,
  "stop_loss": 82800.00,
  "take_profit": 84200.00,
  "confidence": 0.78,
  "confluence": {
    "trend": "bullish",
    "momentum": "neutral",
    "order_flow": "bullish",
    "sentiment": "bullish",
    "macro": "risk-on"
  },
  "reasoning": "Price above all EMAs with expanding MACD histogram..."
}
```

- [ ] **5.3 — Agent Tick Loop** (`packages/trading/agent/lifecycle.ts`)
  - One persistent OpenClaw agent session per trading pair
  - Tick interval: configurable (default 30s for scalping, 5m for swing)
  - **Latency budget**: full tick must complete in < 8 seconds (signal gathering + RAG + LLM inference + risk gate). Alert at > 10s. Skip tick if previous tick still processing (never queue ticks).
  - Each tick:
    1. Gather signals (tools 1–5 in parallel)
    2. RAG query for similar setups
    3. Qwen 3.5 decision with full context
    4. Validate through risk gate (Phase 5.5)
    5. Execute or hold
  - **Limit order management**:
    - Order TTL: configurable (default 60s for scalping, 5m for swing). If unfilled after TTL, cancel and re-evaluate on next tick.
    - Partial fills: accept partial fill, adjust SL/TP proportionally, cancel remaining order quantity.
    - Price moved away: if mid-price moved > 0.5×ATR away from limit price before fill, cancel order (setup has changed) — agent re-evaluates on next tick.
    - All cancel/replace operations go through BullMQ rate limiter.
  - Between ticks: monitor open positions for SL/TP via exchange WS user data stream

- [ ] **5.4 — Multi-Pair Orchestrator**
  - Manage N agent sessions across M pairs
  - Global portfolio awareness: no single pair can exceed X% of total equity
  - Correlation guard: avoid opening same-direction positions on highly correlated pairs (ρ > 0.85)
  - Capital allocation: distribute available capital across active pair agents

- [ ] **5.5 — Risk Management Gate**
  - **Pre-execution checks** (must ALL pass or order is rejected):
    - Position size ≤ Kelly-recommended max
    - Portfolio VaR with new position ≤ configured max (e.g., -5% daily)
    - Daily realized loss < configured max drawdown (default: -3%)
    - Consecutive loss cooldown: after 3 consecutive losses, pause for N ticks
    - Max open positions ≤ configured limit
    - No trading during high-impact macro event window (±30min around CPI, FOMC)
  - **Position monitoring** (continuous):
    - Trailing stop: once in profit > 1×ATR, trail stop at entry + 0.5×ATR
    - Time-based exit: close positions open longer than configured max duration
    - Drawdown circuit breaker: if portfolio drawdown > X%, close all positions and pause

- [ ] **5.6 — Kill-Switch & Manual Override**
  - `/trading stop` via any OpenClaw channel (Telegram, Discord, WhatsApp) → immediately cancel all open orders, close all positions
  - `/trading pause` → stop opening new positions, keep existing ones monitored
  - `/trading status` → P&L summary, open positions, agent state

- [ ] **5.7 — Notifications**
  - Delivered via OpenClaw's existing channel system (Telegram primary):
    - Order placed/filled/cancelled
    - TP/SL hit with P&L
    - Daily summary (total P&L, win rate, Sharpe, top/bottom trade)
    - Risk alerts (drawdown threshold, correlation warning, unusual volatility)
    - Macro event reminder (FOMC in 1h, CPI release)

- [ ] **5.8 — Autonomous Strategy Creator** (`packages/trading/strategy/`)
  - The agent itself designs, tests, and validates its own trading strategies. It uses its quant + sentiment + macro knowledge to hypothesize strategies, backtest them on historical data, run them on exchange testnet, and autonomously decide whether to promote or drop them — no human intervention required.

  - **Strategy Definition Schema** (`strategy.schema.ts`):

```typescript
interface TradingStrategy {
  id: string; // e.g. "btc-trend-follower-v2"
  name: string; // Human-readable name
  version: string; // Semver
  status: "hypothesis" | "backtesting" | "testnet" | "live" | "dropped";
  createdBy: "agent" | "human";
  createdAt: string; // ISO timestamp
  droppedReason?: string; // Why agent dropped it (if applicable)

  // What and which direction to trade
  direction: "long" | "short" | "both"; // Strategy bias — reversal strategies are typically short-only
  pairs: string[]; // e.g. ["BTC/USDT", "ETH/USDT"]
  exchanges: ("binance" | "bybit")[];
  timeframe: "scalp" | "intraday" | "swing";
  tickIntervalMs: number; // Agent tick rate

  // Entry conditions — ALL must be true to open a position
  entry: {
    confluenceMin: number; // Min signal groups aligned (e.g. 3 of 5)
    trend: {
      emaAlignment: "bullish" | "bearish" | "any";
      adxMin?: number; // Minimum ADX for trend strength
      aboveEma200: boolean;
    };
    momentum: {
      rsiRange: [number, number]; // e.g. [30, 70] — avoid extremes
      macdHistogramSign?: "positive" | "negative" | "any";
    };
    orderFlow: {
      obImbalanceMin?: number; // e.g. 0.55 = 55% bid dominance for buys
      cvdDirection?: "accumulation" | "distribution" | "any";
    };
    sentiment: {
      fearGreedRange?: [number, number]; // e.g. [25, 80] — avoid extremes
      sentimentAlign?: boolean; // Require sentiment aligns with trade direction
    };
    macro: {
      regimeRequired?: "risk-on" | "risk-off" | "any";
      noEventBlackout: boolean; // Block entries ±30min around CPI/FOMC
    };
    custom?: string; // Free-form natural language condition for LLM
  };

  // Exit rules
  exit: {
    takeProfitAtr: number; // TP as multiple of ATR (e.g. 2.0 = 2×ATR)
    stopLossAtr: number; // SL as multiple of ATR (e.g. 1.0 = 1×ATR)
    trailingStopActivation: number; // Trailing stop activates at N×ATR profit
    trailingStopDistance: number; // Trail at N×ATR behind price
    maxHoldDurationMs: number; // Force exit after duration
    exitOnRegimeChange: boolean; // Close if macro regime flips
  };

  // Risk per strategy
  risk: {
    maxPositionPct: number; // Max % of equity per trade (e.g. 2%)
    maxOpenPositions: number;
    maxDailyDrawdownPct: number;
    consecutiveLossCooldownTicks: number;
    kellyFractionOverride?: number; // Override global Kelly fraction
  };

  // Performance tracking (filled automatically)
  performance?: {
    backtestSharpe?: number;
    backtestWinRate?: number;
    backtestMaxDrawdown?: number;
    backtestPnlPct?: number;
    testnetSharpe?: number;
    testnetWinRate?: number;
    testnetMaxDrawdown?: number;
    testnetPnlPct?: number;
    testnetDays?: number;
    liveStartedAt?: string;
    liveSharpe?: number;
    liveWinRate?: number;
  };
}
```

- **Strategy CRUD CLI** (for human override when needed):
  - `openclaw trading strategy list` — show all strategies with status + metrics
  - `openclaw trading strategy show <id>` — full strategy detail + performance history
  - `openclaw trading strategy drop <id>` — force-drop a strategy
  - `openclaw trading strategy promote <id>` — manually promote (bypasses agent)

- **Strategy Validator** (`packages/trading/strategy/validator.ts`):
  - Schema validation: all required fields, valid ranges (RSI 0–100, percentages 0–1, etc.)
  - Conflict detection: warn if two live strategies target the same pair
  - Risk sanity check: reject if combined max drawdown across active strategies > global limit

- [ ] **5.9 — Agent Strategy Generation Loop** (`packages/trading/strategy/generator.ts`)
  - The agent autonomously creates new strategies based on what it observes in the market. This runs as a separate BullMQ cron job (default: once per day).
  - **Hypothesis generation** — agent is prompted with:
    - Current market regime (trending/ranging) and recent regime history
    - Best and worst performing existing strategies with their metrics
    - Recent trade outcomes (what worked, what didn't)
    - Current quant features, sentiment, and macro context
    - Similar historical periods from the vector store
  - **Agent tool: `create_strategy(strategy)`** — the agent outputs a full `TradingStrategy` JSON
    - The agent must provide a `reasoning` field explaining WHY this strategy should work in the current regime
    - Pre-creation validation: reject duplicate strategies (>90% similarity to existing parameters)
    - Max active hypotheses: configurable (default 5) to avoid runaway creation
  - **Agent tool: `mutate_strategy(id, changes)`** — the agent can tweak parameters of a dropped or weak strategy
    - e.g., widen RSI range, change confluence threshold, adjust ATR multipliers
    - Creates a new version (old one stays in history for comparison)

- [ ] **5.10 — Autonomous Backtest & Testnet Validation** (`packages/trading/strategy/evaluator.ts`)
  - Every strategy created by the agent goes through a fully automated pipeline — the agent evaluates results and decides the next step.

  - **Stage 1 — Backtest** (automatic, immediate after creation):
    - Replay last 90 days of historical data through the strategy rules + agent
    - **Data availability note**: backtests use OHLCV candle data from TimescaleDB continuous aggregates (available for full 90 days). Order flow analytics (OB imbalance, CVD, whale detection) require raw tick data, which is only retained for 7 days. For the first ~83 days of a backtest, order flow signals are unavailable and the agent operates on candle-based indicators + sentiment + macro only. The final 7 days include full tick-level signals. This is a known limitation — testnet validation (Stage 2) provides the "real" full-signal evaluation.
    - Compute: equity curve, trade count, win rate, Sharpe, max drawdown, profit factor, Calmar ratio
    - **Agent evaluates** the backtest report using a dedicated tool:
      - Tool: `evaluate_backtest(strategyId)` → returns report + agent assessment
      - Agent decides: `promote_to_testnet` | `mutate_and_retest` | `drop`
    - **Promotion thresholds** (configurable, agent can reason about edge cases):
      - Sharpe ≥ 1.0
      - Win rate ≥ 55%
      - Max drawdown ≤ 10%
      - Minimum 50 trades in backtest period
      - Profit factor ≥ 1.5
    - If backtest fails: agent either mutates parameters and retests (max 3 attempts) or drops with a written reason

  - **Stage 2 — Testnet Execution** (real market data, fake money):
    - Deploy strategy to **Binance Testnet** (`testnet.binancefuture.com`) and/or **Bybit Testnet** (`testnet.bybit.com`)
    - Execute real orders on testnet with testnet funds — real price feeds, real order book, simulated fills
    - Testnet adapters: same `BinanceAdapter` / `BybitAdapter` but configured with testnet endpoints + testnet API keys
    - **Minimum testnet duration**: configurable (default 7 days, minimum 3 days)
    - Agent receives daily testnet performance summaries via tool: `get_testnet_report(strategyId)`

  - **Stage 3 — Agent Self-Evaluation** (after minimum testnet period):
    - Agent reviews testnet performance vs. backtest expectations:
      - Tool: `evaluate_testnet(strategyId)` → returns full comparison report
      - Agent sees: backtest metrics vs. testnet metrics side-by-side, slippage analysis, fill rate
    - **Agent decision matrix**:

```
┌─────────────────────────────────┬──────────────────────────┐
│ Testnet Result                  │ Agent Action             │
├─────────────────────────────────┼──────────────────────────┤
│ Sharpe ≥ 1.0 AND               │ PROMOTE TO LIVE          │
│ Win rate within 10% of backtest │ (with reasoning)         │
│ AND drawdown ≤ backtest × 1.5  │                          │
├─────────────────────────────────┼──────────────────────────┤
│ Metrics close but not quite     │ EXTEND testnet +7 days   │
│ (Sharpe 0.7–1.0)               │ or MUTATE parameters     │
├─────────────────────────────────┼──────────────────────────┤
│ Sharpe < 0.7 OR                 │ DROP with written reason │
│ Win rate < 45% OR               │ (stored for learning)    │
│ Drawdown > 15%                  │                          │
└─────────────────────────────────┴──────────────────────────┘
```

    - Every drop includes the agent's written analysis of WHY it failed — this goes into the vector store so the agent avoids similar strategies in the future
    - Example drop reason: *"Strategy relied on mean-reversion in a trending regime. Hurst exponent was 0.67 during testnet period, making counter-trend entries consistently hit SL. Need to add regime filter or switch to trend-following entries."*

- **Stage 4 — Live Promotion** (guarded):
  - When agent promotes to live, it starts with **25% of configured position size** for the first 3 days
  - Scales to 50% for days 4–7, then 100% after 7 days — IF metrics hold
  - If any metric degrades during scale-up, agent can pause scaling or demote back to testnet

- **Continuous live monitoring** — agent reviews each live strategy weekly:
  - Tool: `evaluate_live_strategy(strategyId)` → rolling 7d/30d metrics
  - Auto-demotion triggers (agent executes these autonomously):
    - Rolling 7-day Sharpe < 0.5 → demote to testnet, notify user
    - Rolling 7-day drawdown > strategy's configured max → pause, notify user
    - 5+ consecutive losses → cooldown (existing risk gate), agent re-evaluates strategy
  - Agent can also voluntarily drop a live strategy if it detects regime change that invalidates the strategy thesis

- **Strategy Evolution** — the agent learns from its own strategy history:
  - Before creating new strategies, the agent queries the vector store for past dropped strategies and their failure reasons
  - "What strategies have I tried before? What worked? What failed and why?"
  - This creates a self-improving loop: generate → test → learn from failures → generate smarter strategies

- [ ] **5.11 — Strategy Lifecycle Dashboard Notifications**
  - All strategy lifecycle events pushed to user via OpenClaw channels:
    - `🧪 New strategy hypothesized: "eth-momentum-v3" — starting backtest`
    - `📊 Backtest complete: Sharpe 1.42, win rate 63% — promoting to testnet`
    - `🔴 Testnet failed: "sol-mean-revert-v1" — Sharpe 0.31, dropping (regime mismatch)`
    - `✅ Testnet passed: "btc-trend-follower-v4" — promoting to live at 25% size`
    - `📈 Live scale-up: "btc-trend-follower-v4" → 50% position size (day 4, metrics holding)`
    - `⚠️ Auto-demoted: "eth-momentum-v3" — 7d Sharpe dropped to 0.38, back to testnet`
  - Weekly digest: all active strategies, their status, and agent's assessment of each

### Deliverables

- `packages/trading/agent/` — tools, system prompt, tick loop, orchestrator, risk gate
- `packages/trading/strategy/` — schema, generator, evaluator, testnet runner, lifecycle engine
- `packages/trading/backtest/` — core backtest engine (historical replay through strategy rules + agent)
  - Replay historical data from TimescaleDB, compute: equity curve, trade count, win rate, Sharpe, max drawdown, profit factor, Calmar ratio
  - Used by strategy evaluator (5.10) and extended by dashboard (8.3)
- Config: `agent.pairs[]`, `agent.tickIntervalMs`, `agent.maxOpenPositions`, `agent.maxDailyDrawdown`, `agent.confluenceThreshold`, `strategy.generationSchedule`, `strategy.maxHypotheses`, `strategy.minTestnetDays`, `strategy.promotionThresholds`, `strategy.testnetApiKeys`

---

## Phase 6 — Trade Journal & Dataset Generation

**Goal**: Every agent decision — including all context that led to it — is journaled in a format that directly converts to a fine-tuning dataset.

### Tasks

- [ ] **6.1 — Trade Journal Schema**
  - Append-only JSONL: `{stateDir}/training/trades/{YYYY-MM}.jsonl`
  - **Records ALL decisions — including hold**: The vast majority of ticks result in a "hold" decision. These are equally valuable for fine-tuning because the model must learn WHEN NOT TO TRADE. Journaling only trades creates survivorship bias — the model never sees the signals that correctly led to inaction.
  - **Hold sampling**: To avoid overwhelming the dataset with holds (~99% of ticks), sample holds at a configurable rate (default: 10% of hold decisions, or 100% if the hold was a close call with confidence > 0.4). All actual trades are always journaled at 100%.
  - Each record captures the complete decision context:

```json
{
  "id": "uuid",
  "timestamp": "2026-03-29T14:23:00Z",
  "symbol": "BTC/USDT",
  "model": "qwen3.5:latest",
  "model_version": "v3-ft-20260315",

  "context": {
    "market_snapshot": "...price, spread, OB state...",
    "quant_features": {
      "rsi14": 61.2,
      "macd_histogram": 12.4,
      "hurst": 0.63,
      "regime": "trending"
    },
    "sentiment": {
      "fear_greed": 72,
      "twitter_score": 0.64,
      "top_event": "SEC approves spot ETH options"
    },
    "macro": { "regime": "risk-on", "dxy": 101.2, "us10y": 4.12, "next_fomc_days": 18 },
    "similar_setups": [
      {
        "timestamp": "2026-02-15T09:12:00Z",
        "similarity": 0.94,
        "outcome": "profit",
        "pnl_pct": 2.1
      },
      {
        "timestamp": "2026-03-01T16:45:00Z",
        "similarity": 0.91,
        "outcome": "profit",
        "pnl_pct": 1.4
      }
    ]
  },

  "decision": {
    "action": "buy",
    "quantity": 0.032,
    "order_type": "limit",
    "limit_price": 83410.0,
    "stop_loss": 82800.0,
    "take_profit": 84200.0,
    "confidence": 0.78,
    "confluence": {
      "trend": "bullish",
      "momentum": "neutral",
      "order_flow": "bullish",
      "sentiment": "bullish",
      "macro": "risk-on"
    }
  },

  "agent_reasoning": "Price above all EMAs with expanding MACD histogram...",

  "execution": {
    "order_id": "binance-123456",
    "fill_price": 83412.5,
    "fill_timestamp": "2026-03-29T14:23:02Z",
    "slippage_bps": 0.3
  },

  "outcome": null,
  "pnl_pct": null,
  "close_timestamp": null,
  "close_reason": null,
  "tokens_used": { "input": 4200, "output": 380 }
}
```

- [ ] **6.2 — Outcome Enrichment Worker**
  - BullMQ job monitors open trade records
  - On close event from exchange WS: fill `outcome`, `pnl_pct`, `close_timestamp`, `close_reason` (tp/sl/trailing/timeout/manual)
  - Annotate corresponding `market_embeddings` rows in pgvector (Phase 4.4)
  - Compute per-trade metrics: hold duration, max adverse excursion (MAE), max favorable excursion (MFE)

- [ ] **6.3 — Dataset Exporter CLI**
  - `openclaw trading export-dataset --from 2026-01-01 --to 2026-03-31 --min-confidence 0.3 --include-holds --hold-sample-rate 0.1 --output dataset.jsonl`
  - Filters: outcome (profit/loss/hold), P&L range, confidence, symbol, model version
  - **Default includes ALL outcomes** (profit + loss + hold) — the model needs negative examples to learn what NOT to do. Use `--min-pnl` only for targeted analysis, never for training export.
  - Output format: Chat JSONL with full context replay:

````jsonl
{
  "messages": [
    {
      "role": "system",
      "content": "You are a professional quantitative crypto trader. Analyze all signals using the confluence framework. Output structured JSON decisions."
    },
    {
      "role": "user",
      "content": "Market State:\n{market_snapshot}\n\nQuant Features:\n{quant_features_text}\n\nSentiment:\n{sentiment_text}\n\nMacro:\n{macro_text}\n\nSimilar Historical Setups:\n{similar_setups_text}\n\nMake a trading decision."
    },
    {
      "role": "assistant",
      "content": "{agent_reasoning}\n\n```json\n{decision_json}\n```"
    }
  ]
}
````

### Deliverables

- `packages/trading/journal/` — journal writer, outcome enrichment worker, dataset exporter
- CLI: `openclaw trading export-dataset`

---

## Phase 7 — LLM Fine-Tuning Pipeline

**Goal**: Continuously fine-tune the local model on the bot's own complete trade history — profitable trades, losing trades, AND hold decisions — to create a specialized trading model that improves at both action AND restraint.

> **Hybrid mode note**: In hybrid mode, Phase 7 still applies to the **local Qwen model** used for tick-level decisions. Claude API handles strategy creation and evaluation without fine-tuning. The fine-tuned local model becomes increasingly capable over time, potentially reducing Claude API dependency. You can also use Claude as the **evaluator** in task 7.4 (A/B evaluation) — comparing fine-tuned Qwen vs Claude on the same validation set to measure how close the local model is getting.

### Tasks

- [ ] **7.1 — Training Data Validator** (`packages/trading/finetuning/validator.ts`)
  - Pre-training checks on exported dataset:
    - Minimum dataset size (≥ 200 examples for first run, ≥ 500 for subsequent)
    - **Class balance validation**: dataset must contain all three decision types: profitable trades, losing trades, AND hold decisions. Reject datasets with < 10% holds or < 15% losses — the model needs to learn from bad outcomes, not just good ones.
    - No data leakage: validation split contains no overlapping time windows with training split
    - Format validation: all required fields present, JSON parseable
    - **Outlier flagging**: flag (don't exclude) trades with > 3σ P&L for human review — they may be legitimate edge cases worth learning from
  - Generate training report: dataset stats, class distribution (profit/loss/hold), time coverage

- [ ] **7.2 — unsloth Fine-Tuning Runner**
  - Docker container (extends existing `training-service/`) with:
    - NVIDIA GPU passthrough
    - `unsloth` + `transformers` + `trl` (SFTTrainer)
    - Base model: Qwen 3.5 (pulled from HuggingFace)
  - Training config:
    - LoRA rank: 16, alpha: 32 (parameter-efficient)
    - Learning rate: 2e-5 with cosine schedule
    - Epochs: 3 (with early stopping on validation loss)
    - Max sequence length: 8192 tokens
  - Export: merge LoRA → GGUF (Q4_K_M quantization) → copy to Ollama models directory

- [ ] **7.3 — Automated Training Schedule**
  - BullMQ cron job: evaluate weekly whether retraining is warranted
  - Trigger conditions (any must be met):
    - ≥ 500 new closed trades since last training
    - Win rate has dropped > 5 percentage points from trained model's validation baseline
    - New model version available from upstream (Qwen update)
  - Pipeline: export → validate → train → evaluate → promote or rollback

- [ ] **7.4 — A/B Model Evaluation**
  - Hold out 20% of recent trades as validation set (time-split, not random)
  - Run both base and fine-tuned model on validation set in inference-only mode
  - Metrics:
    - **Decision accuracy**: does the model's action match the outcome direction?
    - **Confidence calibration**: are high-confidence predictions actually more accurate?
    - **Simulated P&L**: replay trades with model's decisions → total P&L
    - **Sharpe ratio**: risk-adjusted return on validation set
  - Promote fine-tuned model only if: Sharpe ≥ base model AND simulated P&L ≥ base model

- [ ] **7.5 — Model Registry**
  - `{stateDir}/training/models/registry.json`:
  - **LLM version pinning**: every registry entry records the exact Ollama model digest (SHA256) of the base model used for training. The agent config pins to a specific digest, not a mutable tag like `:latest`. If `ollama pull qwen3.5` silently updates upstream, the pinned digest ensures behavior doesn't drift. Before promoting a new fine-tuned model, verify the base model digest matches the training run.

```json
{
  "models": [
    {
      "id": "qwen3.5-trading-v1",
      "base": "qwen3.5",
      "baseDigest": "sha256:abc123def456...",
      "trainedAt": "2026-03-15T02:00:00Z",
      "datasetSize": 1247,
      "datasetRange": ["2026-01-01", "2026-03-10"],
      "validationMetrics": {
        "accuracy": 0.68,
        "sharpe": 1.42,
        "simulatedPnlPct": 8.3,
        "confidenceCalibration": 0.71
      },
      "status": "active",
      "ollamaModel": "qwen3.5-trading-v1:latest"
    }
  ]
}
```

- Agent config references model by registry ID
- One-command rollback: `openclaw trading model rollback`

### Deliverables

- `packages/trading/finetuning/` — validator, unsloth runner, scheduler, evaluator, registry
- Config: `finetune.schedule`, `finetune.minTradesBeforeRetrain`, `finetune.loraRank`, `finetune.validationSplit`

---

## Phase 8 — Admin, Observability & Backtesting

**Goal**: Operational visibility, backtesting on historical data, and full control over the system.

### Tasks

- [ ] **8.1 — Trading Dashboard** (OpenClaw web UI extension)
  - **Portfolio overview**: total equity curve, daily/weekly/monthly P&L, Sharpe ratio
  - **Per-pair cards**: live price, position state, unrealized P&L, win rate
  - **Order history table**: sortable by time, pair, P&L, with expandable reasoning summaries
  - **Signal dashboard**: current quant features, sentiment, macro regime — visual indicators
  - **Vector store stats**: total embeddings, avg retrieval latency, outcome distribution

- [ ] **8.2 — Fine-Tuning History UI**
  - Training timeline with metrics per run
  - Active model badge, validation charts (accuracy, Sharpe over time)
  - One-click rollback to any previous model version

- [ ] **8.3 — Backtesting Dashboard & Strategy Comparison** (`packages/trading/backtest/dashboard.ts`)
  - Web UI over the core backtest engine (built in Phase 5.10 for the autonomous strategy evaluator)
  - User-triggered backtests: configurable date range, symbols, tick interval, initial capital
  - Side-by-side comparison: base model vs. fine-tuned model on same historical period
  - Visual equity curves, trade-by-trade drill-down, drawdown charts
  - Export backtest results as CSV / JSON for external analysis

- [ ] **8.4 — Alerting**
  - Threshold-based alerts delivered via OpenClaw channels:
    - Daily drawdown > X%
    - Consecutive losses > N
    - Agent latency spike (tick took > 10s)
    - Exchange disconnection > 30s
    - Macro event approaching (FOMC, CPI)
    - Correlation alert (new position correlated with existing)

- [ ] **8.5 — Audit Log**
  - Every order placement, cancellation, and fill logged with:
    - Timestamp, agent session ID, model version
    - Full reasoning excerpt
    - Risk gate pass/fail details
    - Execution latency (decision → fill)

### Deliverables

- `packages/trading/dashboard/`, `packages/trading/backtest/`
- Config: `dashboard.enabled`, `alerting.drawdownThreshold`, `alerting.consecutiveLossLimit`

---

## Appendix A — Agent Decision Walkthrough

Two complete examples showing how the agent reasons through the full pipeline — from raw signals to order execution — for a long and a short position.

---

### Example 1: Opening a Long Position (BTC/USDT)

**Date**: 2026-04-12, Saturday 14:23 UTC
**Active strategy**: `btc-trend-follower-v4` (status: `live`, promoted from testnet 12 days ago)

#### Step 1 — Tick fires, agent gathers signals in parallel

The agent's tick loop fires on the 30-second interval. Five tool calls execute simultaneously:

**`get_market_snapshot("BTC/USDT")`** returns:

```
Price: 87,240.50 | 1m: +0.18% | 1h: +0.92% | 24h: +3.1%
Bid/Ask: 87,238.0 / 87,243.0 | Spread: 5.0 (Z: -0.31 — normal)
OB Imbalance (top 5): Bid 64% / Ask 36%
24h Volume: $2.1B | Funding rate: +0.008% (neutral, next in 5h42m)
Exchange: Binance USDT-M Futures
```

**`get_quant_features("BTC/USDT")`** returns:

```json
{
  "ema9": 87180,
  "ema21": 86950,
  "ema50": 86420,
  "ema200": 84100,
  "macd": { "line": 142, "signal": 98, "histogram": 44 },
  "adx": 31.2,
  "rsi14": 62.4,
  "stochRsi": 0.71,
  "bollingerPosition": 0.68,
  "atr14": 1380,
  "realizedVol30d": 0.52,
  "obImbalance": 0.64,
  "tradeFlowImbalance": 0.58,
  "cvd1h": 186,
  "hurstExponent": 0.67,
  "priceZScore": 0.84,
  "regime": "trending",
  "kellyFraction": 0.038,
  "var95_1d": -0.041,
  "sharpe30d": 1.61,
  "maxDrawdownCurrent": -0.012,
  "maxPositionSize": 0.045
}
```

**`get_sentiment("BTC/USDT")`** returns:

```
Fear & Greed: 68 (Greed) | 24h change: +5
Twitter(4h): 0.61 bullish | volume: 14,200 tweets
Reddit(4h): 0.54 mildly bullish | top post: "BTC breaking 87K resistance"
Top news: "BlackRock Bitcoin ETF hits $50B AUM" (institutional, high impact)
Funding: +0.008% (neutral — not overcrowded)
Feed accuracy (30d): Fear&Greed 71%, Twitter 62%, Reddit 48%
```

**`get_feed_accuracy()`** returns:

```
Fear & Greed: 71% (reliable)
Twitter sentiment: 62% (moderate)
Reddit sentiment: 48% (below threshold — weight reduced)
CryptoPanic news: 67% (moderate)
FRED macro: 74% (reliable)
```

**`get_macro_context()`** returns:

```
Regime: risk-on
DXY: 100.8 (-0.5% this week) — dollar weakness favors risk assets
US 10Y: 3.98% (-6bps this week)
Last CPI (Apr 10): 2.8% YoY — in line with expectations, no surprise
Last FOMC (Mar 19): hold, dovish tone — "prepared to cut if data supports"
Next FOMC: May 7 (25 days away) — market pricing 68% chance of 25bp cut
Oil (WTI): $76.20 — stable
M2 trend: expanding (+0.3% MoM)
No macro event blackout — next CPI in 29 days
```

#### Step 2 — RAG query for similar historical setups

**`query_similar_setups("BTC/USDT", 5)`** returns:

```
Top 5 similar market states:

1. 2026-02-18T09:15Z | similarity: 0.93 | outcome: PROFIT +2.8%
   Context: EMA aligned bullish, ADX 29, RSI 60, Hurst 0.64, Fear&Greed 65
   Trade: Long BTC, held 4h12m, hit TP at 2×ATR

2. 2026-03-22T11:30Z | similarity: 0.91 | outcome: PROFIT +1.6%
   Context: EMA aligned bullish, ADX 33, RSI 58, Hurst 0.69, Fear&Greed 71
   Trade: Long BTC, held 2h45m, trailed out at 1.5×ATR

3. 2026-01-08T16:00Z | similarity: 0.89 | outcome: PROFIT +3.4%
   Context: Trending regime, strong OB imbalance (0.67), macro risk-on
   Trade: Long BTC, held 6h, hit TP at 2.5×ATR

4. 2026-03-05T08:45Z | similarity: 0.87 | outcome: LOSS -1.1%
   Context: Similar indicators but RSI was 71 (overbought), funding +0.035%
   Trade: Long BTC, held 1h20m, hit SL — entered too late in move

5. 2026-02-28T14:10Z | similarity: 0.85 | outcome: PROFIT +1.9%
   Context: Bullish setup with risk-on macro, OB imbalance 0.61
   Trade: Long BTC, held 3h, trailed out
```

#### Step 3 — Agent reasoning (Qwen 3.5 internal chain of thought)

The agent now has the full picture. Here's how it reasons:

> **Trend analysis**: EMA9 (87,180) > EMA21 (86,950) > EMA50 (86,420) > EMA200 (84,100) — full bullish alignment. Price is 3.7% above EMA200, healthy distance without being overextended. ADX at 31.2 confirms a strong trend in progress. MACD histogram at +44 and expanding — momentum accelerating, not decelerating.
>
> **Verdict: BULLISH** ✅
>
> **Momentum check**: RSI at 62.4 — solidly in bullish territory but NOT overbought (strategy cap is 70). Stochastic RSI at 0.71 — still has room. Bollinger position 0.68 — in the upper half but not touching the band. This is the sweet spot: trending with room to run, unlike similar setup #4 where RSI was already 71 and it failed.
>
> **Verdict: BULLISH** ✅
>
> **Order flow**: OB imbalance 0.64 (bid dominant — heavy buying pressure at top-of-book). Trade flow showing 58% buyer-initiated. CVD +186 BTC in the last hour — sustained accumulation, not a single whale spike. Spread Z-score normal — no liquidity thinning.
>
> **Verdict: BULLISH** ✅
>
> **Sentiment**: Fear & Greed at 68 — Greed, but not Extreme Greed (>80). Strategy allows 25–80. Twitter bullish at 0.61 (62% accuracy — moderate weight). Reddit at 0.54 but only 48% accuracy — I'll give this low weight. Top news is institutional (BlackRock ETF AUM), which is structural demand, not hype. Funding rate neutral at +0.008% — the market is NOT overleveraged long. This is important — high funding (like +0.035% in failed setup #4) would make me cautious because it signals overcrowded positioning.
>
> **Verdict: BULLISH** ✅ (but noting Reddit feed is unreliable — downweighting)
>
> **Macro**: Risk-on regime. Falling DXY (dollar weakness = capital flows into risk assets). Dovish Fed with 68% probability of rate cut in 25 days. Expanding M2 (liquidity injection). No macro event in the blackout window. This is the most favorable macro backdrop for crypto.
>
> **Verdict: RISK-ON** ✅
>
> **Confluence score: 5/5** — all signal groups aligned. Strategy `btc-trend-follower-v4` requires minimum 3/5. This is a high-conviction setup.
>
> **Historical grounding**: 4 out of 5 similar setups in my vector store were profitable (80% hit rate), with an average gain of +2.4%. The one loss (#4) had RSI at 71 and funding at +0.035% — both conditions are absent right now. My current RSI is lower (62.4) and funding is healthier (+0.008%). I'm entering earlier in the move than #4 did.
>
> **Risk sizing**: Kelly fraction says 0.038 BTC. Max safe position size is 0.045 BTC. My account balance supports this. Portfolio VaR with this position stays at -4.1% (under the 5% limit). Max drawdown is currently only -1.2%. No correlated positions open. 0 consecutive losses — no cooldown. I'll use the Kelly recommendation: **0.038 BTC**.
>
> **Entry plan**: Limit order at 87,235 (just below current bid, trying to get filled without chasing). SL at 85,855 = price - 1×ATR (1,380). TP at 89,995 = price + 2×ATR (2,760). Risk/reward ratio: 1:2. If price moves +1×ATR in my favor, trailing stop activates at entry + 0.5×ATR.

#### Step 4 — Structured decision output

```json
{
  "action": "buy",
  "symbol": "BTC/USDT",
  "quantity": 0.038,
  "order_type": "limit",
  "limit_price": 87235.0,
  "stop_loss": 85855.0,
  "take_profit": 89995.0,
  "confidence": 0.82,
  "confluence": {
    "trend": "bullish",
    "momentum": "bullish",
    "order_flow": "bullish",
    "sentiment": "bullish",
    "macro": "risk-on"
  },
  "reasoning": "Full EMA alignment with expanding MACD histogram and ADX 31.2 confirming strong trend. RSI 62.4 — bullish but not overbought (unlike similar failed setup from Mar 5 where RSI was 71). OB imbalance 0.64 and CVD +186 BTC show sustained accumulation. Macro risk-on with falling DXY and dovish Fed. 4/5 similar historical setups profitable with avg +2.4%. Entering via limit below bid at 87,235, SL at 1×ATR, TP at 2×ATR for 1:2 R/R.",
  "strategy_id": "btc-trend-follower-v4",
  "similar_setups_hit_rate": "4/5 (80%)"
}
```

#### Step 5 — Risk gate validation

The risk management gate checks every condition:

```
✅ Position size 0.038 ≤ Kelly max 0.045
✅ Portfolio VaR with new position: -4.1% ≤ -5.0% limit
✅ Daily realized loss: $0 < -3% max drawdown
✅ Consecutive losses: 0 < 3 cooldown threshold
✅ Open positions: 0 < 5 max limit
✅ No macro blackout window (next event: CPI in 29 days)
✅ No correlated position conflict

RISK GATE: PASSED — forwarding order to execution
```

#### Step 6 — Order execution and monitoring

```
→ Order submitted: Binance USDT-M Futures
  BUY LIMIT 0.038 BTC/USDT @ 87,235.00
  SL: 85,855.00 | TP: 89,995.00
  Order ID: binance-7829341

→ Fill received (2.1s later):
  FILLED 0.038 BTC/USDT @ 87,236.50 (slippage: +1.50 = 0.17 bps)

→ Trade journal entry created: trade-2026-0412-1423-btc-long
→ Market embedding rows linked to trade ID for outcome annotation
→ Notification sent: "📈 BTC/USDT LONG opened — 0.038 BTC @ 87,236.50 | SL 85,855 | TP 89,995 | Confidence 82%"
```

**3 hours later**: Price moves +1×ATR to 88,620. Trailing stop activates at entry + 0.5×ATR = 87,926.

**5 hours later**: Price reaches 89,800 but reverses. Trailing stop (now at 88,920) gets hit.

```
→ Position closed: TRAILING STOP at 88,920.00
  Entry: 87,236.50 → Exit: 88,920.00 = +1,683.50 per BTC
  P&L: +$63.97 (+1.93%)
  Hold duration: 5h14m
  Max favorable excursion: +2,563.50 (+2.94%)
  Max adverse excursion: -142.00 (-0.16%)

→ Outcome annotation: market_embeddings rows updated with outcome="profit", pnl_pct=1.93
→ Trade journal enriched with final outcome
→ Notification: "✅ BTC/USDT LONG closed — P&L: +$63.97 (+1.93%) | Trailing stop at 88,920"
```

---

### Example 2: Opening a Short Position (ETH/USDT)

**Date**: 2026-05-03, Saturday 22:15 UTC
**Active strategy**: `eth-reversal-detector-v1` (status: `live`, promoted 8 days ago)

#### Step 1 — Tick fires, agent gathers signals in parallel

**`get_market_snapshot("ETH/USDT")`** returns:

```
Price: 3,842.20 | 1m: -0.08% | 1h: -0.62% | 24h: +6.8%
Bid/Ask: 3,841.50 / 3,843.00 | Spread: 1.50 (Z: +1.87 — widening)
OB Imbalance (top 5): Bid 31% / Ask 69%
24h Volume: $1.8B (elevated — 40% above 7-day avg)
Funding rate: +0.042% (extremely high, next in 2h18m)
Exchange: Bybit Linear
```

**`get_quant_features("ETH/USDT")`** returns:

```json
{
  "ema9": 3855,
  "ema21": 3830,
  "ema50": 3780,
  "ema200": 3520,
  "macd": { "line": 28, "signal": 34, "histogram": -6 },
  "adx": 38.4,
  "rsi14": 78.3,
  "stochRsi": 0.94,
  "bollingerPosition": 0.96,
  "atr14": 112,
  "realizedVol30d": 0.61,
  "obImbalance": 0.31,
  "tradeFlowImbalance": 0.41,
  "cvd1h": -342,
  "hurstExponent": 0.58,
  "priceZScore": 2.14,
  "regime": "trending",
  "kellyFraction": 0.029,
  "var95_1d": -0.054,
  "sharpe30d": 0.87,
  "maxDrawdownCurrent": -0.028,
  "maxPositionSize": 1.8
}
```

**`get_sentiment("ETH/USDT")`** returns:

```
Fear & Greed: 84 (Extreme Greed) | 24h change: +11
Twitter(4h): 0.81 extremely bullish | volume: 28,400 tweets (3× normal!)
Reddit(4h): 0.77 bullish | top post: "ETH TO 5K BY JUNE 🚀🚀🚀"
Top news: "Ethereum Shanghai upgrade anniversary — narrative pump" (technical, medium impact)
Funding: +0.042% (overcrowded longs — historically mean-reverts within 8h)
Feed accuracy (30d): Fear&Greed 71%, Twitter 62%, Reddit 48%
```

**`get_feed_accuracy()`** confirms Reddit still at 48% (downweight).

**`get_macro_context()`** returns:

```
Regime: neutral (mixed signals)
DXY: 102.1 (+0.4% this week) — dollar strengthening slightly
US 10Y: 4.22% (+8bps this week — yields rising)
Next FOMC: May 7 (4 days away!) — uncertainty rising
Market pricing: 52% hold, 48% cut — coin flip → high event risk
Oil (WTI): $81.40 (+4.2% this week — inflationary pressure)
M2 trend: flat (0.0% MoM)
⚠️ FOMC in 4 days — within extended awareness window (not blackout, but caution)
```

#### Step 2 — RAG query for similar historical setups

**`query_similar_setups("ETH/USDT", 5)`** returns:

```
Top 5 similar market states:

1. 2026-01-22T20:30Z | similarity: 0.92 | outcome: PROFIT +3.1% (SHORT)
   Context: RSI 76, funding +0.038%, extreme greed, OB ask-heavy
   Trade: Short ETH, held 6h, sharp reversal to SL of longs

2. 2026-03-14T03:15Z | similarity: 0.90 | outcome: PROFIT +2.2% (SHORT)
   Context: RSI 81, funding +0.045%, MACD histogram turning negative
   Trade: Short ETH, held 8h, cascade of liquidations below support

3. 2026-04-01T18:00Z | similarity: 0.88 | outcome: PROFIT +1.8% (SHORT)
   Context: Price Z-score 2.3, Bollinger 0.98, extreme twitter volume
   Trade: Short ETH, held 4h, mean reversion play

4. 2026-02-10T12:45Z | similarity: 0.86 | outcome: LOSS -2.4% (SHORT)
   Context: Similar overbought but ETF approval news broke — fundamental shift
   Trade: Short ETH, held 45m, hit SL on continuation breakout

5. 2026-04-19T09:30Z | similarity: 0.84 | outcome: PROFIT +4.6% (SHORT)
   Context: Funding +0.051%, RSI 82, pre-FOMC uncertainty
   Trade: Short ETH, held 12h, Fed hawkish surprise accelerated the dump
```

#### Step 3 — Agent reasoning (Qwen 3.5 internal chain of thought)

> **Trend analysis**: EMAs are still bullish (9 > 21 > 50 > 200) and ADX is strong at 38.4. Price is ABOVE all EMAs. In a trend-following context, this screams "buy." BUT — this strategy is `eth-reversal-detector-v1`, designed specifically to catch overextended moves. The trend is intact, but I'm looking for exhaustion, not continuation.
>
> **Verdict: BEARISH** (overextension signal) ✅
>
> **Momentum — THIS IS THE KEY SIGNAL**: RSI at 78.3 — deeply overbought. Stochastic RSI at 0.94 — practically maxed out. Bollinger position 0.96 — price is hugging the upper band with almost no room left. MACD histogram at -6 and FALLING — momentum has already turned negative even while price is still elevated. This is classic bearish divergence: price making highs but momentum fading. The engine is stalling.
>
> **Verdict: BEARISH** ✅
>
> **Order flow — CONFIRMS THE REVERSAL**: OB imbalance at 0.31 — massive ask dominance (69% asks vs 31% bids). Someone is selling into the rally. Trade flow imbalance at 0.41 — majority seller-initiated. CVD at -342 ETH in the last hour — distribution, not accumulation. Spread Z-score at +1.87 — widening significantly, which means market makers are pulling liquidity. They see something. This is the footprint of smart money exiting while retail chases the pump.
>
> **Verdict: BEARISH** ✅
>
> **Sentiment — EXTREME CONTRARIAN SIGNAL**: Fear & Greed at 84 (Extreme Greed) — historically, ETH mean-reverts within 48h when this exceeds 80. Twitter volume at 3× normal with 0.81 bullish score — this is euphoria, not rational positioning. Reddit posting "ETH TO 5K 🚀🚀🚀" — classic late retail FOMO. The narrative is an anniversary pump — no fundamental catalyst.
>
> Most critically: **funding rate at +0.042%**. This means longs are paying shorts 0.042% every 8 hours to hold their positions. At this level, it costs $1.61 per ETH per day just to stay long. Historically in my vector store, when ETH funding exceeds +0.035%, a funding rate mean-reversion event (long squeeze) happens within 8 hours 73% of the time. The market is extremely one-sided — overcrowded longs create the fuel for a cascade.
>
> **Verdict: BEARISH** (extreme contrarian) ✅
>
> **Macro — MIXED / CAUTIOUS**: Regime is neutral. DXY strengthening slightly — mild headwind for crypto. Rising yields and oil = inflationary → reduces rate cut probability. FOMC in 4 days with a coin-flip outcome — this adds uncertainty. Setup #5 in my vector store was a pre-FOMC short that returned +4.6% because uncertainty compresses risk appetite. BUT setup #4 lost -2.4% when unexpected bullish news broke.
>
> **Verdict: NEUTRAL** ⚠️ (uncertain, not aligned clearly either way)
>
> **Confluence score: 4/5** (trend✅, momentum✅, order_flow✅, sentiment✅, macro⚠️). Strategy requires minimum 3/5. Even without macro alignment, this is a high-confluence reversal setup.
>
> **Historical grounding**: 4 out of 5 similar setups in my vector store resulted in profitable shorts (80% hit rate), with average gain +2.9%. The one loss (#4) was caused by an unexpected fundamental catalyst (ETF approval). I see no comparable catalyst today — the news is a narrative/anniversary pump, not a structural shift. I'm confident this is exhaustion, not breakout.
>
> **Risk sizing**: Kelly fraction says 1.8 ETH max (based on strategy's historical win rate). My strategy's risk cap is 2% per trade. FOMC in 4 days adds event risk, so I'll use **conservative Kelly: 75% of max = 1.35 ETH** instead of the full 1.8. VaR with this position: -4.8% (under 5% limit). One open BTC long exists but ETH/BTC 30-day correlation is 0.72 — below the 0.85 threshold, no conflict. Different direction anyway (long BTC, short ETH = pairs-like exposure, which actually reduces portfolio risk).
>
> **Entry plan**: Limit short at 3,844 (above current ask, selling into the remaining bid liquidity). SL at 3,956 = price + 1×ATR (112). TP at 3,620 = price - 2×ATR (224). Risk/reward: 1:2. Trailing stop activates at -1×ATR, trails at 0.5×ATR above price.

#### Step 4 — Structured decision output

```json
{
  "action": "sell",
  "symbol": "ETH/USDT",
  "quantity": 1.35,
  "order_type": "limit",
  "limit_price": 3844.0,
  "stop_loss": 3956.0,
  "take_profit": 3620.0,
  "confidence": 0.76,
  "confluence": {
    "trend": "bearish (overextension)",
    "momentum": "bearish",
    "order_flow": "bearish",
    "sentiment": "bearish (extreme contrarian — euphoria + overcrowded funding)",
    "macro": "neutral"
  },
  "reasoning": "Classic exhaustion setup: RSI 78.3 overbought with MACD histogram turning negative (bearish divergence). OB 69% ask-heavy with CVD -342 (distribution). Spread widening at +1.87σ signals market makers pulling liquidity. Funding +0.042% = overcrowded longs, historically triggers mean-reversion within 8h. Fear & Greed 84 Extreme Greed + euphoric Twitter volume (3× normal) = late retail FOMO. 4/5 similar setups in vector store were profitable shorts (avg +2.9%). Reduced to 75% Kelly due to FOMC in 4 days.",
  "strategy_id": "eth-reversal-detector-v1",
  "similar_setups_hit_rate": "4/5 (80%)"
}
```

#### Step 5 — Risk gate validation

```
✅ Position size 1.35 ≤ Kelly max 1.8
✅ Portfolio VaR with new position: -4.8% ≤ -5.0% limit
✅ Daily realized loss: $0 < -3% max drawdown
✅ Consecutive losses: 0 < 3 cooldown threshold
✅ Open positions: 1 (BTC long) < 5 max limit
✅ No macro blackout (FOMC in 4 days — outside ±30min window)
✅ Correlation check: ETH/BTC ρ=0.72 < 0.85 threshold; opposite direction reduces portfolio risk

RISK GATE: PASSED — forwarding order to execution
```

#### Step 6 — Order execution, liquidation cascade, and exit

```
→ Order submitted: Bybit Linear
  SELL SHORT LIMIT 1.35 ETH/USDT @ 3,844.00
  SL: 3,956.00 | TP: 3,620.00
  Order ID: bybit-2847291

→ Fill received (0.8s later):
  FILLED 1.35 ETH/USDT @ 3,843.50 (slippage: -0.50 = 1.3 bps — favorable!)

→ Notification: "📉 ETH/USDT SHORT opened — 1.35 ETH @ 3,843.50 | SL 3,956 | TP 3,620 | Confidence 76%"
```

**2 hours later** — Funding rate settles: longs pay +0.042% → cascading de-leveraging begins. Price drops to 3,780. Trailing stop activates at entry - 1×ATR = 3,731.50.

**4 hours later** — Major liquidation cascade: $48M in long liquidations on Bybit alone. Price plunges through 3,700 as cascading stops and liquidation engine accelerate the move. Bybit liquidation data shows 12,400 ETH-perp positions forcefully closed between 3,750 and 3,680.

**5 hours later** — Price bottoms at 3,641 and bounces. Trailing stop (now at 3,670) gets hit on the bounce.

```
→ Position closed: TRAILING STOP at 3,670.00
  Entry: 3,843.50 → Exit: 3,670.00 = 173.50 per ETH
  P&L: +$234.22 (+4.51%)
  Hold duration: 5h02m
  Max favorable excursion: 202.50 (+5.27%)
  Max adverse excursion: -18.00 (-0.47%)

→ Outcome annotation: market_embeddings rows updated with outcome="profit", pnl_pct=4.51
→ Trade journal enriched with final outcome
→ Similar setup #5 (pre-FOMC short) is now the closest comparable — this trade outperformed it
→ Notification: "✅ ETH/USDT SHORT closed — P&L: +$234.22 (+4.51%) | Trailing stop at 3,670 | Funding squeeze played out as projected"
```

---

### What the Agent Learned (Vector Store Feedback Loop)

Both trades get embedded into the vector store with their outcomes. The next time the agent encounters a similar market state:

- **Setup like Example 1** (trending + confluence + healthy funding): the vector store now has one more data point confirming that bullish-aligned trend-following entries at RSI < 65 with neutral funding work well.
- **Setup like Example 2** (overbought + extreme funding + euphoric sentiment): the vector store reinforces that mean-reversion shorts during funding extremes have a high hit rate, especially pre-FOMC.

If the **BTC long had lost**, the agent's fine-tuning dataset would include it as a negative example — teaching the model to recognize false signals. If the **ETH short had failed** (e.g., because of unexpected bullish news like in similar setup #4), the agent would store the failure reason in the vector store: _"Overextension signals can be overridden by unexpected fundamental catalysts. Absence of catalyst is not confirmation it won't arrive."_

This is how the system self-improves: every trade — win or loss — makes the vector store and the fine-tuned model smarter.

---

## Technology Stack

| Concern                   | Selected Stack                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Exchanges                 | Binance (Spot + USDT-M Futures) + Bybit (Spot + Linear) — native WebSocket                                      |
| Time-series storage       | TimescaleDB (Postgres extension) with continuous aggregates                                                     |
| Vector database           | pgvector (same Postgres instance) — IVFFlat index                                                               |
| Embedding model           | `nomic-embed-text` via Ollama (768-dim)                                                                         |
| Trading LLM (local mode)  | Qwen 3.5 via Ollama (base) → fine-tuned GGUF variants                                                           |
| Trading LLM (hybrid mode) | Claude Sonnet/Opus via Anthropic API (strategy & evaluation) + local Qwen (tick decisions)                      |
| Fine-tuning runtime       | `unsloth` + LoRA + GGUF export (Q4_K_M) → Ollama (local mode only; hybrid mode relies on Claude's base quality) |
| Order execution           | Direct exchange WS API (Binance WS Order API + Bybit WS Trade API)                                              |
| Testnet                   | Binance Testnet (`testnet.binancefuture.com`) + Bybit Testnet (`testnet.bybit.com`)                             |
| Rate limiting             | BullMQ per-exchange rate limiter with 80% safety margin                                                         |
| Sentiment analysis        | Qwen 3.5 NLP classification + Fear & Greed API + RSS feeds                                                      |
| Macro data                | FRED API (CPI, yields, M2) + forex API (DXY)                                                                    |
| Quant math                | Custom TypeScript — indicators, stats, risk (Kelly, VaR, Sharpe)                                                |
| Job scheduling            | BullMQ — all async jobs, cron triggers, training pipeline                                                       |
| Database                  | Single Postgres instance with TimescaleDB + pgvector extensions                                                 |

---

## Package Structure

```
openclaw/
├── packages/
│   └── trading/
│       ├── ingestion/           # WS adapters (Binance, Bybit), OB state machine, TimescaleDB writer
│       ├── sentiment/           # Crypto sentiment feeds, news classifier, macro data
│       ├── quant/               # Indicators, order flow, stats, risk math, feature vector
│       ├── vector/              # Serializer, embedding pipeline, pgvector integration
│       ├── agent/               # Tools, system prompt, tick loop, orchestrator, risk gate
│       │   ├── tools/           # get_market_snapshot, place_order, get_sentiment, etc.
│       │   ├── prompts/         # System prompt templates + risk policy
│       │   └── lifecycle/       # Tick loop, multi-pair orchestrator, kill-switch
│       ├── strategy/            # Strategy schema, CRUD, validator, simulator, promotion
│       ├── journal/             # Trade journal writer, outcome enrichment, dataset exporter
│       ├── finetuning/          # Validator, unsloth runner, scheduler, evaluator, registry
│       ├── backtest/            # Historical replay engine, strategy comparison
│       └── dashboard/           # Web UI extension for OpenClaw
└── docs/
    └── trading-bot-roadmap.md   ← this file
```

---

## Milestones

| Phase       | Description                                                                                                 | Depends On     | Est. Effort                               |
| ----------- | ----------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------- |
| **Phase 1** | Market data ingestion (WS + OB + TimescaleDB)                                                               | —              | 2–3 weeks                                 |
| **Phase 2** | Sentiment & geoeconomic intelligence + feed verification                                                    | —              | 2–3 weeks                                 |
| **Phase 3** | Quantitative math engine                                                                                    | Phase 1        | 2 weeks                                   |
| **Phase 4** | Embedding & vector store (pgvector)                                                                         | Phases 1, 2, 3 | 1–2 weeks                                 |
| **Phase 5** | Trading agent + autonomous strategy creator (agent generates, backtests, testnet validates, promotes/drops) | Phases 3, 4    | 5–6 weeks                                 |
| **Phase 6** | Trade journal & dataset generation                                                                          | Phase 5        | 1 week                                    |
| **Phase 7** | LLM fine-tuning pipeline (unsloth → GGUF)                                                                   | Phase 6        | 2–3 weeks                                 |
| **Phase 8** | Admin, backtesting dashboard & observability                                                                | Phase 5        | 2–3 weeks                                 |
| **Total**   |                                                                                                             |                | **~4–5 months** (critical path: 17 weeks) |

**Parallel tracks**: Phases 1 + 2 run simultaneously (no dependencies). Phase 3 starts as soon as Phase 1 delivers OHLCV. Phase 8 runs in parallel with Phase 7 (no dependency between them). The core backtest engine is built in Phase 5; Phase 8.3 only adds the dashboard UI and comparison features.

> **Critical path**: P1 (3w) → P3 (2w) → P4 (2w) → P5 (6w) → P6 (1w) → P7 (3w) = **17 weeks ≈ 4–5 months**. P2 and P8 run in parallel and don't extend the critical path.

### LLM Inference Cost & Throughput Budget

| Parameter                  | Value                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| Tick interval              | 30 seconds                                                                                       |
| Active pairs               | 5 (BTC, ETH, SOL, XRP, BNB)                                                                      |
| LLM calls per minute       | 10 (1 per pair per tick)                                                                         |
| Avg input tokens per call  | ~4,500 (system prompt + RAG context + quant features)                                            |
| Avg output tokens per call | ~300 (structured JSON decision)                                                                  |
| Hourly throughput          | ~2.7M input tokens + ~180K output tokens                                                         |
| Required generation speed  | ≥ 40 tok/s to stay within 30s tick budget (with 8s latency target)                               |
| Recommended GPU            | RTX 3090/4090 (24GB VRAM) — runs Qwen 3.5 Q4_K_M at ~45-60 tok/s                                 |
| VRAM usage                 | ~18-20 GB for Qwen 3.5 14B Q4_K_M with 8K context                                                |
| Concurrent requests        | Ollama `OLLAMA_NUM_PARALLEL=2` — process 2 pairs simultaneously, 5 pairs serialize in ~15s total |

> **Note (local mode)**: All inference is local — no API costs. The only ongoing cost is electricity (~300W GPU). If throughput becomes a bottleneck with more pairs, add a second GPU or switch to a smaller fine-tuned model (7B Q5_K_M runs at ~80 tok/s on RTX 3090).

### LLM Provider Modes

OpenClaw's unified `ProviderPlugin` interface means the trading agent code is **provider-agnostic** — switching between modes is a config change, not a code change. Both providers can be registered simultaneously.

#### Mode A — Local-Only (Qwen 3.5 via Ollama)

| Aspect          | Details                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider        | Ollama (`OLLAMA_API_KEY=ollama-local`)                                                                                                        |
| Model           | Qwen 3.5 14B Q4_K_M (base) → fine-tuned variants                                                                                              |
| Hardware        | **RTX 3090/4090** (24GB VRAM) or **Mac Studio M4 Ultra** (128GB unified)                                                                      |
| Cost            | $0 API — electricity only (~$2-5/day)                                                                                                         |
| Fine-tuning     | Full self-improving loop (Phase 7) — unsloth + LoRA → GGUF                                                                                    |
| Privacy         | 100% local — no trade data leaves the machine                                                                                                 |
| Latency         | ~1-3s per call (no network)                                                                                                                   |
| Mac Studio note | Use `mlx-lm` + LoRA instead of unsloth (no CUDA). Fine-tune ~2-3x slower but 128GB allows full-precision training. Inference at ~50-70 tok/s. |

#### Mode B — Hybrid (Claude API + Local Qwen)

Use Claude for tasks where reasoning quality matters most, local Qwen for high-frequency decisions where cost and latency matter.

| Task                                          | Provider                    | Why                                                                                 |
| --------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| Strategy creation (5.8)                       | **Claude Sonnet**           | Better at creative hypothesis generation and multi-factor reasoning                 |
| Strategy evaluation & A/B testing (5.10, 7.4) | **Claude Opus**             | Most rigorous analysis of backtest results and edge cases                           |
| Sentiment NLP classification (2.1)            | **Claude Haiku**            | Fast, cheap, accurate text classification                                           |
| Tick-level trade decisions (5.2)              | **Local Qwen** (fine-tuned) | 10 calls/min × 5 pairs — cost-prohibitive on Claude; fine-tuning improves over time |
| Trade journal annotation (6.1)                | **Local Qwen**              | High volume, lower stakes                                                           |

| Aspect        | Details                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Providers     | Anthropic (`ANTHROPIC_API_KEY=sk-ant-...`) + Ollama (for tick decisions)                                    |
| Claude models | Sonnet 4.6 (strategy), Opus 4.6 (evaluation), Haiku 4.5 (classification)                                    |
| Cost estimate | ~$8-20/day Sonnet, ~$20-50/day if using Opus for evaluation (varies with volume)                            |
| Fine-tuning   | Still applies to local Qwen for tick decisions (Phase 7); Claude has no fine-tuning                         |
| Advantage     | Superior base reasoning from day one — no waiting for fine-tuning to accumulate                             |
| Tradeoff      | Ongoing API cost; trade context sent to Anthropic servers; dependent on API availability                    |
| Hardware      | Mac Studio M4 Ultra 128GB ideal — handles local Qwen inference + all other services, no discrete GPU needed |

**Switching between modes** — single config change:

```bash
# ~/.openclaw/.env
# Mode A (local-only):
OLLAMA_API_KEY=ollama-local

# Mode B (hybrid) — add Claude alongside:
ANTHROPIC_API_KEY=sk-ant-...
OLLAMA_API_KEY=ollama-local
```

The agent's task router selects the provider per-task based on config. Both can run simultaneously — if Claude API goes down, the system degrades gracefully to local-only mode.

> **Recommended path**: Start with **Mode B (hybrid)** to get superior strategy generation from day one while the local model accumulates training data. As the fine-tuned Qwen improves, gradually shift more tasks to local. Monitor the gap between Claude and Qwen on the same validation set (task 7.4) — when they converge, switch to Mode A and eliminate API costs entirely.

---

## Key Risks & Mitigations

| Risk                             | Mitigation                                                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exchange API rate limits         | BullMQ rate limiter at 80% of published limits; separate queues per exchange                                                                                                                                     |
| Model hallucinating orders       | Pre-execution risk gate validates ALL orders against Kelly/VaR/position limits before touching capital                                                                                                           |
| Overfitting to a market regime   | Time-split validation (not random); Hurst exponent + HMM detect regime changes; auto-pause in regime transitions                                                                                                 |
| Sentiment data noisy/unreliable  | Confluence requirement: sentiment alone never triggers a trade; must align with ≥2 other signal groups                                                                                                           |
| Macro data delayed / missing     | Graceful degradation: agent proceeds with `macro_regime: "unknown"` if FRED API fails; no trades blocked by missing macro                                                                                        |
| Stale embeddings in vector store | TTL on embeddings (oldest get pruned); outcome annotations only on last 90 days                                                                                                                                  |
| WebSocket disconnects            | Exponential backoff reconnect; alert at > 30s; OB state machine re-snapshots on reconnect                                                                                                                        |
| Slippage on large orders         | Dynamic position sizing respects OB depth; split large orders across price levels (iceberg)                                                                                                                      |
| Black swan / flash crash         | Global circuit breaker: portfolio drawdown > 5% → close all → pause → require manual resume                                                                                                                      |
| Training data poisoning          | Outlier detection: exclude trades with > 3σ P&L from training set; human review before first deployment                                                                                                          |
| Testnet liquidity unrealistic    | Testnet order books are thin/fake — apply simulated slippage model calibrated against live mainnet OB depth; Stage 4 live promotion starts at 25% target size; compare testnet fills vs mainnet book depth daily |

---

## Execution Order

1. **Weeks 1–3**: Phase 1 (ingestion) + Phase 2 (sentiment) in parallel — testnet data feeds
2. **Weeks 3–5**: Phase 3 (quant engine) — compute indicators from live data
3. **Weeks 5–7**: Phase 4 (embedding + vector store) — start accumulating embedded market states
4. **Weeks 7–13**: Phase 5 (trading agent + autonomous strategy creator) — agent generates, backtests, and runs strategies on exchange testnet
5. **Weeks 13–14**: Phase 6 (journal) — capture testnet trade data into training format
6. **Weeks 14–17**: Phase 7 (fine-tuning) — first training run from testnet trade data
7. **Weeks 13–16**: Phase 8 (dashboard + observability) — runs in parallel with Phase 7
8. **Week 17+**: Cautious live deployment with minimal capital — promoted strategies only

> **Rule**: No real capital until at least one agent-created strategy passes the full pipeline: backtest Sharpe > 1.0 AND testnet validation win rate > 55% sustained over minimum testnet period (7 days).
