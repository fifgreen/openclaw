# Feature Specification: Market Data Ingestion

**Feature Branch**: `002-market-data-ingestion`
**Created**: 2026-04-04
**Status**: Draft
**Scope**: Phase 1 of the trading bot roadmap (see `docs/trading-bot-roadmap.md`). This spec covers the real-time market data ingestion layer: WebSocket adapters for Binance and Bybit, normalized event schema, order book state machine, TimescaleDB time-series persistence, BullMQ-gated REST rate limiting, and a one-time historical data bootstrap CLI. It does NOT cover sentiment ingestion (Phase 2), quantitative math (Phase 3), vector embeddings (Phase 4), or trade execution (Phase 5). It depends on the MemDir (Redis KV) primitives from `001-advanced-context-memory`.
**Depends on**: `001-advanced-context-memory` (MemDir / Redis KV store)
**Package**: `extensions/market-data-ingestion/` as `@openclaw/market-data-ingestion`

---

## User Scenarios & Testing _(mandatory)_

### User Story 1 — Live Price Feed Available to the Trading Agent (Priority: P1)

As a trading agent, I need to read the latest price tick for any configured symbol from the shared memory directory without initiating an exchange API call myself, so my context window stays focused on strategy evaluation rather than data plumbing.

**Why this priority**: The price tick is the atomic unit of trading decisions. Until a reliable, low-latency tick is being written into MemDir, no downstream agent logic (quant math, strategy evaluation, order execution) can function. All other stories depend on this foundation.

**Independent Test**: With the plugin running against Binance testnet, call `get_latest_tick("BTC/USDT")` via the OpenClaw tool interface. The returned `PriceTick` must have a `timestamp` no older than 2 seconds and a `localTimestamp` reflecting ingestion receipt time.

**Acceptance Scenarios**:

1. **Given** the plugin has connected to the Binance WebSocket feed for `BTC/USDT`, **When** a trade executes on the exchange, **Then** within 500 ms a `PriceTick` record is written to the MemDir key `binance:tick:BTC/USDT` and is readable via `get_latest_tick("BTC/USDT")`.
2. **Given** the WebSocket connection drops unexpectedly, **When** reconnection occurs, **Then** tick updates resume automatically within 30 seconds using exponential backoff, and the last known tick remains readable from MemDir during the reconnect window.
3. **Given** two symbols are configured (`BTC/USDT`, `ETH/USDT`), **When** ticks arrive for both concurrently, **Then** each symbol's MemDir key is updated independently without crosstalk or data corruption.

---

### User Story 2 — Order Book Snapshot Available to the Trading Agent (Priority: P1)

As a trading agent, I need to call `get_ob_snapshot("BTC/USDT")` and receive a current, internally consistent order book so I can compute spread, mid-price, and market imbalance to inform entry/exit decisions.

**Why this priority**: The order book is the primary microstructure input for entry timing and slippage estimation. Without a consistent local OB, the quant math layer (Phase 3 OB imbalance, spread Z-score) has no data source.

**Independent Test**: Subscribe to the Bybit `BTC/USDT` order book stream. Pause delta delivery artificially to simulate a sequence gap, then verify the OB state machine triggers a re-snapshot and re-applies subsequent deltas before making the book externally readable again.

**Acceptance Scenarios**:

1. **Given** the plugin has bootstrapped a full order book snapshot from the exchange, **When** incremental delta events arrive, **Then** the local OB is updated in sequence order and `getTopOfBook()`, `getMidprice()`, `getSpread()`, and `getImbalance()` return values consistent with the exchange's current published book.
2. **Given** a gap is detected in the exchange sequence IDs (missed delta), **When** the gap is detected, **Then** the plugin re-requests a full snapshot within 1 second and replays subsequent deltas without exposing a stale or inconsistent book externally.
3. **Given** a call to `get_ob_snapshot("BTC/USDT", depth: 5)`, **When** the tool responds, **Then** the snapshot contains exactly 5 best bid levels and 5 best ask levels, sorted correctly (bids descending, asks ascending).

---

### User Story 3 — Funding Rate Available for Perpetual Futures Positions (Priority: P2)

As a trading agent running a perpetual futures strategy, I need to read the current funding rate for a symbol to factor carry cost into hold-vs-exit decisions and avoid entering positions when funding is punishingly high.

**Why this priority**: Funding rates can flip short-term P&L on leveraged positions. This is a secondary data type that does not block basic spot trading but is essential for any futures strategy.

**Independent Test**: With the plugin running against Bybit Linear (USDT perpetuals), call `get_funding_rate("BTC/USDT")`. The returned `FundingRate.nextFundingTime` must be in the future and `rate` must be non-zero and within a plausible range (−0.1% to +0.1%).

**Acceptance Scenarios**:

1. **Given** the funding rate stream is active, **When** the exchange publishes a new funding rate update, **Then** the MemDir key `binance:funding:BTC/USDT` (or bybit equivalent) is updated and `get_funding_rate("BTC/USDT")` returns the new rate within 5 seconds.
2. **Given** the next funding settlement occurs, **When** the countdown resets to 8h, **Then** `nextFundingTime` in the returned record reflects the new settlement epoch.

---

### User Story 4 — Historical OHLCV Candles for Backtesting and Indicators (Priority: P2)

As a quantitative math engine (Phase 3), I need to query OHLCV candles from TimescaleDB across multiple timeframes (1m, 5m, 1h) to compute technical indicators such as RSI, MACD, and Bollinger Bands without re-fetching from the exchange on every tick.

**Why this priority**: Continuous aggregates pre-compute candles from raw ticks. Without cached candles, every indicator call would require an expensive exchange REST query, making high-frequency decisions impractical.

**Independent Test**: After the bootstrap CLI has run for `BTC/USDT --days 7`, call `get_ohlcv("BTC/USDT", "1h", 168)`. Verify that exactly 168 records are returned for the trailing 7 days with no gaps and that `open`, `high`, `low`, `close`, `volume` are all non-zero.

**Acceptance Scenarios**:

1. **Given** the TimescaleDB continuous aggregate for 1m candles is active, **When** a minute boundary passes, **Then** a new 1m candle is materialized from the accumulated `price_ticks` for that interval and is readable via `get_ohlcv("BTC/USDT", "1m", 1)`.
2. **Given** a query for `get_ohlcv("BTC/USDT", "5m", 100)`, **When** the tool responds, **Then** 100 candles are returned in ascending time order and the 5m aggregate values are consistent with the underlying 1m data.
3. **Given** the retention policy is active, **When** a raw tick is older than 7 days, **Then** it is dropped from `price_ticks` but the aggregated 1m candle calculated from it persists in the 1m aggregate table for 90 days.

---

### User Story 5 — Historical Bootstrap Seeds Initial TimescaleDB State (Priority: P3)

As an operator deploying the system for the first time, I need to run a single CLI command that backfills the last 90 days of 1m candles and funding rate history so the quantitative math layer has sufficient historical data to compute long-window indicators without waiting weeks for live data to accumulate.

**Why this priority**: A 90-day backfill is a one-time setup requirement. It is not needed for live tick operation but is critical before running any indicator-based backtest or strategy validation.

**Independent Test**: On a freshly initialized TimescaleDB (empty tables), run `openclaw trading bootstrap --symbols BTC/USDT --days 7`. After completion, verify that the `price_ticks` continuous aggregate contains 7 × 24 × 60 = 10,080 non-null 1m candles for BTC/USDT with no more than 2% gaps (exchange maintenance windows expected).

**Acceptance Scenarios**:

1. **Given** an empty TimescaleDB, **When** `openclaw trading bootstrap --symbols BTC/USDT,ETH/USDT --days 90` is executed, **Then** 90 days of 1m candles and funding rate history are inserted for each symbol, the command exits cleanly, and the inserted row count is logged.
2. **Given** the bootstrap command is re-run on a database that already has data, **When** it checks the existing max timestamp per symbol, **Then** it only fetches the missing time range and skips already-populated intervals (idempotent).
3. **Given** the bootstrap is running, **When** the exchange REST API rate limit is approached, **Then** the command uses the BullMQ rate limiter at 50% of the normal request quota to avoid bans, and logs progress at each symbol/chunk boundary.

---

### User Story 6 — Write Buffer Protects TimescaleDB Under High-Volume Tick Load (Priority: P2)

As the ingestion pipeline, I need to batch-insert ticks into TimescaleDB rather than writing each tick individually so the database is not overwhelmed during high-volatility periods when ticks arrive at hundreds per second.

**Why this priority**: TimescaleDB insert overhead is non-trivial at high frequency. Batching is the critical reliability mechanism that allows raw tick storage without database saturation.

**Independent Test**: Simulate 5,000 ticks arriving within 200 ms (e.g., replay a synthetic burst). Verify that TimescaleDB receives at most 2 insert batches (flush at 1,000 rows, then remainder at 500 ms timer), not 5,000 individual inserts, and that no ticks are silently discarded unless the write queue exceeds 10,000 events.

**Acceptance Scenarios**:

1. **Given** ticks are arriving at a sustained rate of 500 per second, **When** 1,000 ticks have accumulated in the write buffer, **Then** a batch insert is triggered immediately (before the 500 ms timer fires).
2. **Given** tick volume drops to near-zero, **When** 500 ms elapses since the last batch flush, **Then** any buffered ticks (even if fewer than 1,000) are flushed to TimescaleDB.
3. **Given** the write queue grows beyond 10,000 pending events (write backpressure), **When** new ticks arrive, **Then** the oldest ticks are dropped, a warning is logged with the drop count, and OB snapshots are never dropped regardless of queue depth.

---

### Edge Cases

- What happens when the exchange sends a sequence ID that is out of order but not a gap (duplicate or replay)? → Duplicates are detected by comparing against the last applied sequence ID and silently discarded.
- How does the order book state machine handle the case where the initial snapshot fetch itself fails? → Retry with exponential backoff (same policy as reconnect). The OB for that symbol remains unavailable and `get_ob_snapshot` returns an error until a successful snapshot is received.
- What if TimescaleDB is unreachable at startup? → The plugin starts successfully and begins buffering ticks in memory. TimescaleDB connection is retried in the background. If unavailable for more than 60 seconds, a warning is logged and the operator is notified via OpenClaw channels. Tick data continues to be written to MemDir (real-time state is unaffected).
- What happens when a configured symbol does not exist on one exchange but does on the other? → Per-exchange subscription failures for unknown symbols are logged with a warning. The symbol continues to be served from the exchange where it is valid; the missing exchange's data fields are absent from the response.
- How does the system handle clock skew between local and exchange timestamps? → `localTimestamp` always uses the local clock at receipt. `timestamp` uses the exchange-provided value without adjustment. Consumers should use `localTimestamp` for latency measurement and `timestamp` for event ordering.
- What if the BullMQ Redis connection is unavailable? → REST API calls are routed through an in-process `TokenBucketQueue` that enforces the same per-exchange rate caps (960/480 RPM) without BullMQ. A warning is logged. This fallback avoids unprotected burst that could trigger exchange IP bans. An operator alert is sent via OpenClaw channels in live operation.

---

## Requirements _(mandatory)_

### Functional Requirements

**WebSocket Adapters**

- **FR-001**: The plugin MUST provide a `BinanceAdapter` and `BybitAdapter`, each implementing `connect()`, `disconnect()`, `subscribe(symbols: string[])`, `onTick(cb)`, and `onOBDelta(cb)`.
- **FR-002**: Each adapter MUST automatically reconnect after connection loss using exponential backoff (base 1 s, cap 30 s, with jitter) without operator intervention.
- **FR-003**: Each adapter MUST detect dead connections via per-connection heartbeat/ping-pong and trigger reconnect if no message is received for more than 10 seconds.
- **FR-004**: The `BinanceAdapter` MUST open two WebSocket connections — one to the Spot base URL (`wss://stream.binance.com:9443`) and one to USDT-M Futures (`wss://fstream.binance.com`) — and subscribe to the `@trade`, `@depth@100ms`, and `@markPrice` streams on each. Both connections share the same reconnect and heartbeat policy.
- **FR-005**: The `BybitAdapter` MUST subscribe to the `trade`, `orderbook.50`, and `tickers` streams for both Spot and Linear (USDT perpetual) instruments.

**Normalized Event Schema**

- **FR-006**: All price ticks MUST be normalized into a `PriceTick` interface with fields: `exchange`, `symbol` (unified format `BASE/QUOTE`, e.g. `BTC/USDT`), `price`, `quantity`, `side`, `tradeId`, `timestamp` (exchange epoch ms), `localTimestamp` (receipt epoch ms).
- **FR-007**: All order book snapshots MUST be normalized into an `OrderBookSnapshot` interface with fields: `exchange`, `symbol`, `bids` (sorted descending), `asks` (sorted ascending), `depth`, `sequenceId`, `timestamp`.
- **FR-008**: All funding rate events MUST be normalized into a `FundingRate` interface with fields: `exchange`, `symbol`, `rate`, `nextFundingTime`, `timestamp`.

**Order Book State Machine**

- **FR-009**: The plugin MUST maintain a local order book per symbol per exchange by applying incremental deltas to an initial full snapshot.
- **FR-010**: The order book state machine MUST detect sequence ID gaps. On gap detection, it MUST discard the current local state, re-request a full snapshot, and re-apply deltas received after the snapshot.
- **FR-011**: The order book MUST expose `getTopOfBook(symbol)`, `getMidprice(symbol)`, `getSpread(symbol)`, and `getImbalance(symbol, depth)` as internal methods used by OpenClaw tool handlers.
- **FR-012**: The order book depth MUST be configurable: `top 5` (default for agent decisions) and `top 20` (for analytics). Consumers may request a specific depth via the `get_ob_snapshot` tool's optional `depth` parameter.

**MemDir Integration**

- **FR-013**: On each new tick, the plugin MUST write the latest `PriceTick` to the MemDir key `{exchange}:tick:{symbol}` (e.g., `binance:tick:BTC/USDT`).
- **FR-014**: On each new OB state update, the plugin MUST write the current `OrderBookSnapshot` to the MemDir key `{exchange}:ob:{symbol}`.
- **FR-015**: On each new funding rate update, the plugin MUST write the `FundingRate` to the MemDir key `{exchange}:funding:{symbol}`.
- **FR-016**: All MemDir writes MUST include an `updatedAt` timestamp and a `ttlMs` aligned with the expected update frequency (ticks: 5 s, OB: 5 s, funding: 600 s) so the MemDir freshness check from `001-advanced-context-memory` (FR-007) functions correctly.

**TimescaleDB Persistence**

- **FR-017**: The plugin MUST persist all `PriceTick` events to a `price_ticks` hypertable in TimescaleDB.
- **FR-018**: The plugin MUST persist sampled `OrderBookSnapshot` events (one per symbol per configurable interval, default every 10 seconds) to an `ob_snapshots` hypertable.
- **FR-019**: The plugin MUST persist all `FundingRate` events to a `funding_rates` hypertable.
- **FR-020**: The plugin MUST maintain continuous aggregates for 1m, 5m, and 1h OHLCV candles computed from `price_ticks`. Note: the bootstrap CLI (FR-027) inserts historical data as synthetic `price_ticks` rows (one aggregated tick per 1m candle with `price=close, quantity=volume`), so continuous aggregates produce correct results from both live and bootstrapped data. An alternative `ohlcv_bootstrap` staging table may be used if synthetic tick injection causes data-quality concerns — decide during implementation.
- **FR-021**: TimescaleDB retention policies MUST enforce: raw `price_ticks` retained 7 days; 1m candles retained 90 days; 1h candles retained indefinitely.
- **FR-022**: All TimescaleDB writes MUST use a write buffer that flushes on whichever condition is met first: 1,000 rows accumulated OR 500 ms elapsed since the last flush.
- **FR-023**: When the write buffer exceeds 10,000 pending events, the plugin MUST drop the oldest `PriceTick` events first (logging the drop count as a warning) and MUST NOT drop `OrderBookSnapshot` or `FundingRate` events.

**BullMQ Rate Limiter**

- **FR-024**: All outbound REST API calls to Binance MUST pass through a BullMQ queue named `trading:ratelimit:binance`, capped at 960 requests per minute (80% of the 1,200 req/min exchange limit).
- **FR-025**: All outbound REST API calls to Bybit MUST pass through a BullMQ queue named `trading:ratelimit:bybit`, capped at 480 requests per minute (80% of the 600 req/min exchange limit).
- **FR-026**: WebSocket connections MUST NOT be rate-limited through BullMQ; only REST API calls require queueing.

**Historical Data Bootstrap**

- **FR-027**: The plugin MUST provide a CLI command `openclaw trading bootstrap --symbols <list> [--days <n>]` that fetches historical 1m candles and funding rate history from exchange REST APIs and inserts them into TimescaleDB.
- **FR-028**: The bootstrap CLI MUST be idempotent: before fetching, it MUST check the maximum existing timestamp per symbol in TimescaleDB and only fetch the missing time range.
- **FR-029**: The bootstrap CLI MUST respect the BullMQ rate limiter, capped at 50% of the normal exchange rate limit during bootstrap to avoid triggering exchange IP bans.
- **FR-030**: The bootstrap progress MUST be logged to the terminal (symbol, time range, rows inserted) and the command MUST exit non-zero on unrecoverable errors.

**OpenClaw Tool Registration**

- **FR-031**: The plugin MUST register the following OpenClaw tools via `openclaw/plugin-sdk/core`:
  - `get_latest_tick(symbol: string, exchange?: "binance" | "bybit") → PriceTick` — if `exchange` is omitted, return the tick with the most recent `timestamp` across all active exchanges
  - `get_ob_snapshot(symbol: string, exchange?: "binance" | "bybit", depth?: number) → OrderBookSnapshot` — if `exchange` is omitted, return the snapshot from the exchange with the tightest spread
  - `get_funding_rate(symbol: string, exchange?: "binance" | "bybit") → FundingRate` — if `exchange` is omitted, return the funding rate from the exchange with the most recent update
  - `get_ohlcv(symbol: string, timeframe: "1m" | "5m" | "1h", limit?: number) → OHLCV[]`
  - `bootstrap_historical_data(symbols: string[], days?: number) → { status: string, imported: number }`

### Non-Functional Requirements

- **NFR-001**: End-to-end latency from exchange trade event to MemDir write MUST be under 500 ms at the 99th percentile under normal network conditions.
- **NFR-002**: The plugin MUST handle at least 1,000 combined tick events per second across all configured symbols without dropping events (subject to the 10,000-event backpressure limit).
- **NFR-003**: The plugin MUST NOT degrade the OpenClaw host process event loop; all blocking I/O MUST be asynchronous.
- **NFR-004**: All configuration values (symbols, OB depth, retention periods, rate limits, flush intervals) MUST be overridable via the plugin's `openclaw.plugin.json` config schema; sensible defaults MUST be provided.
- **NFR-005**: The plugin MUST log all connection lifecycle events (connect, disconnect, reconnect, gap detection, re-snapshot) at `info` level, and all data-loss events (tick drops, OB reset) at `warn` level.
- **NFR-006**: API credentials for Binance and Bybit MUST be stored as `SecretRef` values (never logged or exposed in tool output).

### Key Entities

- **PriceTick**: A single executed trade from an exchange. Attributes: `exchange`, `symbol`, `price`, `quantity`, `side`, `tradeId`, `timestamp`, `localTimestamp`.
- **OrderBookSnapshot**: A point-in-time view of the top N bid/ask levels for a symbol. Attributes: `exchange`, `symbol`, `bids[]`, `asks[]`, `depth`, `sequenceId`, `timestamp`.
- **FundingRate**: The current periodic funding rate for a perpetual futures contract. Attributes: `exchange`, `symbol`, `rate`, `nextFundingTime`, `timestamp`.
- **OHLCV**: An aggregated candle derived from `PriceTick` rows. Attributes: `symbol`, `timeframe`, `open`, `high`, `low`, `close`, `volume`, `timestamp`.
- **ExchangeAdapter**: Per-exchange WebSocket client managing connection lifecycle, subscriptions, and event normalization.
- **OrderBookStateMachine**: Per-symbol OB manager that applies deltas to a base snapshot and detects/recovers from sequence gaps.
- **WriteBuffer**: In-memory accumulator that batches `PriceTick`, `OrderBookSnapshot`, and `FundingRate` rows before flushing to TimescaleDB.
- **RateLimiter**: A BullMQ queue per exchange that serializes and throttles outbound REST API calls.

---

## Out of Scope

The following are explicitly excluded from this phase:

- **Sentiment ingestion** (Fear & Greed, Twitter, Reddit, news feeds) — Phase 2.
- **Geoeconomic macro data** (DXY, FOMC, CPI, M2) — Phase 2.
- **Technical indicator computation** (RSI, MACD, Bollinger Bands) — Phase 3.
- **Order flow analytics** (CVD, trade flow imbalance, large trade detection) — Phase 3.
- **pgvector embeddings** of market state — Phase 4.
- **Trade execution** (order placement, position management) — Phase 5.
- **Strategy evaluation and backtest** — Phase 5.
- **Multi-exchange arbitrage detection** — out of roadmap scope.
- **Historical raw tick data** (unavailable via REST; only candles and funding rates are backfilled).
- **Mobile or web UI** for monitoring the ingestion pipeline (operator observability is CLI/channel-based only).

---

## Dependencies

### Internal (must be deployed and healthy before this plugin starts)

| Dependency                | Provided by                   | Used for                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MemDir (Redis KV)         | `001-advanced-context-memory` | Real-time state writes: latest tick, OB snapshot, funding rate per symbol                                                                                                                                                               |
| MemDir API + Redis client | `001-advanced-context-memory` | `createMemDir` factory and `getRedisClient()` — this plugin sets its own TTLs on writes (5s for ticks/OB, 600s for funding); the dependency is on the MemDir API surface and shared Redis connection, not on plugin 001's TTL semantics |
| OpenClaw plugin SDK       | `openclaw/plugin-sdk/core`    | Tool registration, plugin lifecycle hooks                                                                                                                                                                                               |
| OpenClaw channel system   | Core                          | Operator alerts (TimescaleDB unavailable, backpressure drops, reconnect events)                                                                                                                                                         |

### External Services

| Service                            | Purpose                                                    | Notes                         |
| ---------------------------------- | ---------------------------------------------------------- | ----------------------------- |
| Binance WebSocket API              | Real-time price ticks, OB deltas, mark price               | Spot + USDT-M Futures streams |
| Binance REST API                   | Historical klines, funding rate history (bootstrap)        | Rate limited via BullMQ       |
| Bybit WebSocket API                | Real-time price ticks, OB deltas, tickers                  | Spot + Linear streams         |
| Bybit REST API                     | Historical klines, funding rate history (bootstrap)        | Rate limited via BullMQ       |
| TimescaleDB (PostgreSQL extension) | Time-series persistence for ticks, OB snapshots, candles   | New infrastructure dependency |
| Redis                              | BullMQ broker (rate limiter queues) + MemDir backing store | Shared with plugin 001        |
| BullMQ                             | REST API rate limiting queue                               | New npm dependency            |

---

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: The latest tick for any configured symbol is readable via `get_latest_tick` within 500 ms of the exchange trade event at the 99th percentile, measured over a 24-hour window under normal network conditions.
- **SC-002**: Following a simulated WebSocket connection drop, the feed is automatically restored and ticks are flowing again within 30 seconds, without any operator action.
- **SC-003**: When a sequence gap is injected into the OB delta stream, the order book state machine re-requests a snapshot and delivers a consistent book within 1 second, with no stale or inconsistent reads exposed externally during recovery.
- **SC-004**: TimescaleDB write throughput sustains at least 1,000 ticks per second for a minimum of 60 consecutive seconds without data loss (subject to the 10,000-event backpressure limit) and without degrading the host process event loop.
- **SC-005**: The bootstrap CLI completes ingestion of 90 days of 1m candles for two symbols (`BTC/USDT`, `ETH/USDT`) within 15 minutes, with fewer than 2% missing candles (accounting for expected exchange maintenance gaps), and is confirmed idempotent on a second run (no duplicate rows, same exit code).
- **SC-006**: Running the bootstrap CLI twice on the same dataset produces identical TimescaleDB state (row counts and timestamp ranges are equal), confirming idempotency.
- **SC-007**: All five registered OpenClaw tools (`get_latest_tick`, `get_ob_snapshot`, `get_funding_rate`, `get_ohlcv`, `bootstrap_historical_data`) are callable from an OpenClaw agent session and return structurally valid, non-empty responses for a configured symbol.
- **SC-008**: No API credentials (exchange API keys, secrets) appear in log output, tool responses, or error messages at any log level.

---

## Assumptions

- Both Binance and Bybit API credentials (for REST authentication) are provided by the operator as `SecretRef` config values before plugin startup. WebSocket-only market data streams that do not require authentication are used for real-time feeds; credentials are only required for authenticated REST endpoints (account state, order placement — used here only during bootstrap for rate-limited kline fetches that may require signed requests on some endpoints).
- TimescaleDB is provisioned and reachable (connection URL provided via plugin config) before the plugin starts. Database schema migrations (hypertables, continuous aggregate policies, retention policies) are applied automatically by the plugin at first start.
- Redis is already running and healthy (provisioned as part of `001-advanced-context-memory`). The BullMQ rate limiter reuses the same Redis instance.
- The configured trading symbols exist on both exchanges. If a symbol is unavailable on one exchange, the plugin gracefully logs a warning and continues on the available exchange.
- Only USDT-margined perpetual futures are in scope for Bybit Linear and Binance USDT-M. Coin-margined futures (COIN-M) are excluded.
- The operator configures which symbols to subscribe to via the plugin's `ingestion.symbols[]` config. The plugin does not auto-discover symbols.
- OB snapshot sampling (persisted to TimescaleDB) defaults to one snapshot per symbol per 10 seconds. Full OB delta state is maintained in memory only. The MemDir holds the latest OB snapshot for real-time reads.
- Historical tick data is not available via exchange REST APIs; only aggregated candles (OHLCV) and funding rate history are bootstrapped. Order flow analytics (CVD, trade flow imbalance) are available only from live tick data going forward.
- The system runs in a single Node.js process (no multi-process sharding). High-volume tick handling relies on async batching and buffering, not horizontal scaling.
