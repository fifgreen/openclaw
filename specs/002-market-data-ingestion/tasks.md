# Tasks: Market Data Ingestion

**Revised**: 2026-04-04  
**Depends on**: `001-advanced-context-memory` (`@openclaw/trading-context` — MemDir / Redis KV store)  
**Package**: `extensions/market-data-ingestion/` as `@openclaw/market-data-ingestion`

---

## Phase 1: Setup

**Purpose**: Scaffold the plugin package so all subsequent phases have a valid workspace package to build into.

- [x] T001 Initialize `extensions/market-data-ingestion/` with `package.json` (`@openclaw/market-data-ingestion`, ESM, `"type": "module"`), `openclaw.plugin.json` (plugin id, display name, empty configSchema stub), `tsconfig.json` extending root config, and `src/` subdirectory tree (`schema/`, `adapters/`, `ob/`, `db/migrations/`, `ratelimit/`, `bootstrap/`, `tools/`)
- [x] T002 [P] Create `index.ts` shell exporting a `definePluginEntry` stub and `runtime-api.ts` exporting an `OpenClawPluginApi` type alias (mirrors the `trading-context` pattern from `extensions/trading-context/runtime-api.ts`)
- [x] T003 [P] Create `src/api.ts` public exports surface (re-exports normalized types and MemDir bridge helpers) and `src/adapters/types.ts` declaring the `ExchangeAdapter` interface (`connect()`, `disconnect()`, `subscribe(symbols: string[])`, `onTick(cb)`, `onOBDelta(cb)`, `onFundingRate(cb)`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core schemas, database infrastructure, write buffering, and rate-limiting queues that ALL user stories depend on. No user story work can begin until this phase is complete.

### Normalized Event Schemas

- [x] T004 Define `PriceTick` Zod schema and inferred TypeScript type in `src/schema/PriceTick.ts` — fields: `exchange` (string), `symbol` (BASE/QUOTE string), `price` (number), `quantity` (number), `side` ("buy" | "sell"), `tradeId` (string), `timestamp` (epoch ms), `localTimestamp` (epoch ms)
- [x] T005 [P] Define `OrderBookSnapshot` Zod schema and type in `src/schema/OrderBookSnapshot.ts` — fields: `exchange`, `symbol`, `bids` (array of `[price, qty]` sorted descending), `asks` (array sorted ascending), `depth` (number), `sequenceId` (number), `timestamp` (epoch ms)
- [x] T006 [P] Define `FundingRate` Zod schema and type in `src/schema/FundingRate.ts` — fields: `exchange`, `symbol`, `rate` (number), `nextFundingTime` (epoch ms), `timestamp` (epoch ms)
- [x] T007 [P] Define `OHLCV` Zod schema and type in `src/schema/OHLCV.ts` — fields: `symbol`, `timeframe` ("1m" | "5m" | "1h"), `open`, `high`, `low`, `close`, `volume` (all numbers), `timestamp` (epoch ms)
- [x] T008 [P] Write colocated schema tests in `src/schema/PriceTick.test.ts`, `src/schema/OrderBookSnapshot.test.ts`, `src/schema/FundingRate.test.ts`, `src/schema/OHLCV.test.ts` — valid payload parses without error; missing required field throws ZodError; extra fields stripped; numeric fields reject strings

### TimescaleDB Infrastructure

- [x] T009 Implement `pg` Pool singleton in `src/db/client.ts` — lazy-init on first use, connection URL from plugin config, `getPool(): Pool` and `closePool(): Promise<void>` exports, typed query helper `query<T>(sql, params): Promise<T[]>`
- [x] T010 Write migration SQL in `src/db/migrations/001_initial.sql` — `price_ticks` hypertable (partitioned on `timestamp`, chunk 1 day); `ob_snapshots` hypertable; `funding_rates` hypertable; `ohlcv_1m`, `ohlcv_5m`, `ohlcv_1h` continuous aggregate views computed from `price_ticks`; TimescaleDB retention policies (raw ticks: 7 days, 1m aggregate: 90 days, 1h aggregate: indefinite); compression policy on `price_ticks` after 2 days

### Write Buffer

- [x] T011 Implement generic `WriteBuffer<T>` in `src/db/WriteBuffer.ts` — constructor accepts `{ maxRows: number, flushIntervalMs: number, maxQueueDepth: number, onFlush: (rows: T[]) => Promise<void> }`; `push(row: T): void` appends and triggers immediate flush when `buffer.length >= maxRows`; interval timer fires flush every `flushIntervalMs`; when `buffer.length >= maxQueueDepth`, drop the oldest row and emit a `warn` log with running drop count; `maxQueueDepth: Infinity` disables drops (used for OB and FundingRate buffers per FR-023); `start(): void` and `stop(): Promise<void>` for lifecycle management (`stop()` clears timer and awaits final flush)
- [x] T012 [P] Write colocated tests in `src/db/WriteBuffer.test.ts` — flush fires when `maxRows` threshold hit; flush fires when timer elapses with fewer rows; oldest row dropped and warning logged when `maxQueueDepth` exceeded; `maxQueueDepth: Infinity` buffer never drops; `stop()` drains remaining rows before resolving; concurrent `push()` calls do not corrupt buffer

### BullMQ Rate Limiter

- [x] T013 Define BullMQ queue configs in `src/ratelimit/queues.ts` — `createRateLimitQueue(exchange, redisClient, opts): Queue` factory for `trading:ratelimit:binance` (960 jobs/min cap) and `trading:ratelimit:bybit` (480 jobs/min cap); if Redis unavailable at creation time, fall back to an in-process `TokenBucketQueue` that enforces the same per-exchange rate cap (960/480 RPM) without BullMQ, and log a warning
- [x] T014 [P] Implement `rateLimitedRest<T>(exchange, fn: () => Promise<T>, opts?: { quotaFraction?: number }): Promise<T>` wrapper in `src/ratelimit/rest.ts` — enqueues a BullMQ job, resolves when the worker executes `fn`; `quotaFraction` (default 1.0) scales the active rate cap (e.g., 0.5 halves throughput for bootstrap mode)
- [x] T015 [P] Write tests in `src/ratelimit/rest.test.ts` — rate cap is respected (mocked BullMQ limiter); `quotaFraction: 0.5` halves effective throughput; Redis-unavailable path falls back to in-process FIFO and completes the call; Promise resolves with the function's return value

**Checkpoint**: Schemas validated, WriteBuffer class proven, pg client ready, BullMQ wired — user story implementation can now begin.

---

## Phase 3: User Story 1 — Live Price Feed (Priority: P1) 🎯 MVP

**Goal**: BinanceAdapter and BybitAdapter connect, normalize ticks, and hot-write to MemDir within 500 ms of exchange event; `get_latest_tick` tool reads the result correctly.

**Independent Test**: Plugin connected to Binance testnet; call `get_latest_tick("BTC/USDT")`; returned `PriceTick.timestamp` is no older than 2 seconds and `localTimestamp` reflects local receipt time.

- [x] T016 [US1] Implement `BinanceAdapter` in `src/adapters/BinanceAdapter.ts` — subscribes to `@trade`, `@depth@100ms`, and `@markPrice` streams for both Spot and USDT-M Futures endpoints; exponential backoff reconnect (base 1 s, cap 30 s, ±25% jitter); 10 s heartbeat interval: sends `ws.ping()`; reconnects if no `pong` within 5 s; normalizes raw trade messages to `PriceTick` via Zod parse; emits parsed events via `onTick(cb)` and `onOBDelta(cb)` callbacks
- [x] T017 [P] [US1] Implement `BybitAdapter` in `src/adapters/BybitAdapter.ts` — subscribes to `trade`, `orderbook.50`, and `tickers` streams for Spot and Linear (USDT perpetual); same reconnect and heartbeat policy as `BinanceAdapter`; normalizes to shared `PriceTick` / `OrderBookSnapshot` / `FundingRate` types
- [x] T018 [US1] Write mock-WebSocket tests for `BinanceAdapter` in `src/adapters/BinanceAdapter.test.ts` — `onTick` callback receives a valid `PriceTick` after a synthetic trade message; adapter reconnects when connection emits `close`; dead-connection (no message for >10 s) triggers `ping` then `reconnect()`; symbol normalization (`BTCUSDT` → `BTC/USDT`); Zod parse failure on malformed payload logs warn and does not crash the adapter; verify `info`-level log on connect/disconnect/reconnect events and `warn`-level log on data-loss events (per NFR-005)
- [x] T019 [P] [US1] Write mock-WebSocket tests for `BybitAdapter` in `src/adapters/BybitAdapter.test.ts` — same coverage matrix applied to Bybit message envelope format; includes NFR-005 logging assertions (info on lifecycle, warn on data-loss)
- [x] T020 [US1] Wire the price tick pipeline in `index.ts`: adapter `onTick` callback → `PriceTickSchema.parse(raw)` → `memDir.set("{exchange}:tick:{symbol}", tick, { ttlMs: 5000 })` → `priceTickBuffer.push(tick)`; use the `createMemDir` helper from `@openclaw/trading-context` with the shared Redis client
- [x] T021 [P] [US1] Add `batchInsertTicks(rows: PriceTick[]): Promise<void>` to `src/db/queries.ts` — parameterized multi-row `INSERT INTO price_ticks ... ON CONFLICT DO NOTHING` using the pg Pool from `src/db/client.ts`
- [x] T022 [US1] Implement `get-latest-tick` tool handler in `src/tools/get-latest-tick.ts` — accepts `(symbol: string, exchange?: "binance" | "bybit")`; if `exchange` provided, reads `memDir.get("{exchange}:tick:{symbol}")`; if omitted, reads ticks from all active exchanges and returns the one with the most recent `timestamp`; returns the `PriceTick` if fresh (TTL not expired); returns a typed error `{ error: "stale" | "not_found" }` if absent or TTL-expired; register the tool signature `get_latest_tick(symbol, exchange?) → PriceTick`

**Checkpoint**: US1 fully testable — ticks flow from exchange → MemDir → tool response.

---

## Phase 4: User Story 2 — Order Book Snapshot (Priority: P1)

**Goal**: Local OB maintained per symbol by applying deltas to snapshots; gap detection triggers re-snapshot within 1 s; `get_ob_snapshot` returns a depth-filtered, correctly sorted book.

**Independent Test**: Subscribe to Bybit `BTC/USDT` OB stream; artificially pause delta delivery to create a sequence gap; verify the state machine transitions to `resyncing`, fetches a new snapshot, replays buffered deltas, transitions back to `live`, and only then makes the book readable via `get_ob_snapshot`.

- [x] T023 [US2] Implement `OrderBookStateMachine` in `src/ob/OrderBookStateMachine.ts` — per-`(exchange, symbol)` instance; maintains sorted `Map<number, number>` for bids (descending) and asks (ascending); `status: "uninitialized" | "snapshotting" | "live" | "resyncing"`; `applyDelta(delta)` checks `seqId > lastSequenceId + 1` → gap → transition to `resyncing`, buffer subsequent deltas, call `fetchSnapshot()` via `rateLimitedRest`; `qty === 0` removes the price level; `seqId <= lastSequenceId` discards silently; `getTopOfBook(depth)`, `getMidprice()`, `getSpread()`, `getImbalance(depth)` return `undefined` when `status !== "live"`
- [x] T023b [US2] Implement OB REST snapshot fetchers in `src/ob/fetch-snapshot.ts` — `fetchBinanceSnapshot(symbol, depth): Promise<OrderBookSnapshot>` calls Binance `GET /api/v3/depth?symbol={symbol}&limit={depth}` via `rateLimitedRest("binance", fn, { priority: 1 })`; `fetchBybitSnapshot(symbol, depth): Promise<OrderBookSnapshot>` calls Bybit `GET /v5/market/orderbook?category=linear&symbol={symbol}&limit={depth}` via `rateLimitedRest("bybit", fn, { priority: 1 })`; both validate response with Zod schema before returning; used by `OrderBookStateMachine.fetchSnapshot()` during gap recovery
- [x] T024 [US2] Write tests in `src/ob/OrderBookStateMachine.test.ts` — sequential deltas update bids/asks correctly; gap triggers `resyncing` status and calls `fetchSnapshot`; buffered deltas are replayed in order after re-snapshot; duplicate `seqId` is silently discarded; depth-5 `getTopOfBook` returns exactly 5 bid and 5 ask levels; all query methods return `undefined` during `resyncing`; `qty === 0` removes the price level
- [x] T025 [P] [US2] Wire the OB delta pipeline in `index.ts`: adapter `onOBDelta` → state machine `applyDelta()` → on state machine `live` event emit `snapshot = machine.getTopOfBook(20)` → `memDir.set("{exchange}:ob:{symbol}", snapshot, { ttlMs: 5000 })` → `obSnapshotBuffer.push(snapshot)` (sampled: only push if last sample was >10 s ago per symbol)
- [x] T026 [P] [US2] Add `batchInsertOBSnapshots(rows: OrderBookSnapshot[]): Promise<void>` to `src/db/queries.ts` — `INSERT INTO ob_snapshots ... ON CONFLICT DO NOTHING`
- [x] T027 [US2] Implement `get-ob-snapshot` tool handler in `src/tools/get-ob-snapshot.ts` — accepts `(symbol: string, exchange?: "binance" | "bybit", depth?: number)`; if `exchange` omitted, return snapshot from the exchange with the tightest spread; applies `depth` parameter (default 5, cap at 20) by slicing `bids` and `asks`; validates bid-side descending order and ask-side ascending order before returning; returns typed error if stale or unavailable

**Checkpoint**: US2 fully testable — OB gap recovery and depth-filtered snapshots work end-to-end.

---

## Phase 5: User Story 6 — Write Buffer / TimescaleDB Protection (Priority: P2)

**Goal**: WriteBuffer instances are wired to pg batch-insert callbacks; high-volume tick bursts result in ≤2 pg INSERT calls per 200 ms burst, not one per tick; OB and FundingRate rows are never dropped under any tick overflow condition.

**Independent Test**: Inject 5,000 synthetic ticks within 200 ms; assert TimescaleDB (mock pg) receives at most 2 `INSERT` calls total; assert that OB rows in the concurrent OB buffer are untouched.

- [x] T028 [US6] Create `src/db/buffers.ts` — instantiates and exports the three singleton `WriteBuffer` instances: `priceTickBuffer = new WriteBuffer<PriceTick>({ maxRows: 1000, flushIntervalMs: 500, maxQueueDepth: 10000, onFlush: batchInsertTicks })`, `obSnapshotBuffer = new WriteBuffer<OrderBookSnapshot>({ maxRows: 1000, flushIntervalMs: 500, maxQueueDepth: Infinity, onFlush: batchInsertOBSnapshots })`, `fundingRateBuffer = new WriteBuffer<FundingRate>({ maxRows: 1000, flushIntervalMs: 500, maxQueueDepth: Infinity, onFlush: batchInsertFundingRates })`
- [x] T029 [P] [US6] Write backpressure integration test in `src/db/WriteBuffer.integration.test.ts` — mock the `onFlush` callback for all three buffers; push 5,000 ticks and 50 OB snapshots concurrently within 200 ms; assert mock tick flush called ≤ 2 times (1,000-row boundary reached at 1,000 and 2,000, timer flush handles remainder); assert OB flush mock called without any rows being dropped; assert drop-count warning logged for tick buffer overflow
- [x] T030 [P] [US6] Wire `WriteBuffer` lifecycle into plugin deactivation in `index.ts` — `onDeactivate` awaits `Promise.all([priceTickBuffer.stop(), obSnapshotBuffer.stop(), fundingRateBuffer.stop()])` before closing the pg pool and disconnecting adapters

**Checkpoint**: TimescaleDB is protected — batch writes proven; OB/Funding rows confirmed never-drop.

---

## Phase 6: User Story 3 — Funding Rate (Priority: P2)

**Goal**: Current funding rate for any perpetual futures symbol is written to MemDir on each exchange update and readable via `get_funding_rate` within 5 seconds.

**Independent Test**: Plugin running against Bybit Linear; call `get_funding_rate("BTC/USDT")`; returned `FundingRate.nextFundingTime` is in the future and `rate` is within plausible range (−0.1% to +0.1%).

- [x] T031 [US3] Wire the funding rate pipeline in `index.ts`: adapter `onFundingRate` callback → `FundingRateSchema.parse(raw)` → `memDir.set("{exchange}:funding:{symbol}", rate, { ttlMs: 600000 })` → `fundingRateBuffer.push(rate)`
- [x] T032 [P] [US3] Add `batchInsertFundingRates(rows: FundingRate[]): Promise<void>` to `src/db/queries.ts` — `INSERT INTO funding_rates ... ON CONFLICT (exchange, symbol, timestamp) DO NOTHING`
- [x] T033 [US3] Implement `get-funding-rate` tool handler in `src/tools/get-funding-rate.ts` — accepts `(symbol: string, exchange?: "binance" | "bybit")`; if `exchange` omitted, return the funding rate with the most recent update; reads `memDir.get("{exchange}:funding:{symbol}")`; validates `nextFundingTime > Date.now()` before returning; returns typed error `{ error: "stale" | "not_found" }` otherwise

**Checkpoint**: US3 fully testable — funding rate flow from exchange stream → MemDir → tool response.

---

## Phase 7: User Story 4 — OHLCV Candles (Priority: P2)

**Goal**: `get_ohlcv` returns aggregated candles from TimescaleDB continuous aggregates across 1m/5m/1h timeframes with correct time ordering and no gaps for live data.

**Independent Test**: After 7 days of live data (or bootstrap run), call `get_ohlcv("BTC/USDT", "1h", 168)`; verify 168 non-null records in ascending timestamp order, all OHLC values non-zero.

- [x] T034 [US4] Add OHLCV query helper to `src/db/queries.ts` — `queryOHLCV(symbol, timeframe: "1m" | "5m" | "1h", limit: number): Promise<OHLCV[]>`; selects from the matching continuous aggregate view (`ohlcv_1m`, `ohlcv_5m`, `ohlcv_1h`); `ORDER BY timestamp ASC LIMIT $3`; maps rows to the `OHLCV` Zod type
- [x] T035 [P] [US4] Write tests for `queryOHLCV` in `src/db/queries.test.ts` — mock pg Pool; verify correct SQL emitted per timeframe (correct view name, correct ORDER BY, LIMIT applied); ascending timestamp order guaranteed; 168-row request produces at most 168 rows in response
- [x] T036 [US4] Implement `get-ohlcv` tool handler in `src/tools/get-ohlcv.ts` — calls `queryOHLCV`, validates result is non-empty (returns typed error if no data), maps rows to `OHLCV[]`; register tool signature `get_ohlcv(symbol: string, timeframe: "1m" | "5m" | "1h", limit?: number) → OHLCV[]`

**Checkpoint**: US4 fully testable — OHLCV candles queryable from TimescaleDB via tool.

---

## Phase 8: User Story 5 — Historical Bootstrap CLI (Priority: P3)

**Goal**: `openclaw trading bootstrap --symbols BTC/USDT --days 7` backfills historical 1m candles and funding rates idempotently; re-run skips already-populated intervals; BullMQ rate is capped at 50% during bootstrap.

**Independent Test**: Fresh TimescaleDB (empty tables); run `openclaw trading bootstrap --symbols BTC/USDT --days 7`; verify `ohlcv_1m` contains 10,080 non-null rows for BTC/USDT; re-run produces 0 new inserts; progress logs appear per chunk.

- [x] T037 [US5] Implement `HistoricalBootstrap` class in `src/bootstrap/HistoricalBootstrap.ts` — constructor accepts `{ pool, rateLimitedRest, logger }`; `run(symbols, days)` method: for each symbol, query `MAX(timestamp)` from `price_ticks` to find existing coverage → fetch missing range via Binance/Bybit REST klines endpoint using `rateLimitedRest(exchange, fn, { quotaFraction: 0.5 })` → insert via `batchInsertTicks` in chunks of 1,000 → log progress `{ symbol, rangeStart, rangeEnd, rowsInserted }` per chunk → throw on unrecoverable HTTP errors (bootstrap CLI exits non-zero)
- [x] T038 [P] [US5] Write tests in `src/bootstrap/HistoricalBootstrap.test.ts` — idempotency: mock pg returns an existing `MAX(timestamp)`; verify only the remaining time range is fetched; verify `rateLimitedRest` called with `quotaFraction: 0.5`; verify progress logged per chunk boundary; empty DB case → full `days`-length range fetched; unrecoverable error (4xx exchange response) → `run()` rejects
- [x] T039 [US5] Implement `bootstrap-historical-data` tool handler in `src/tools/bootstrap-historical-data.ts` — instantiates `HistoricalBootstrap` and calls `run(symbols, days)`; returns `{ status: "ok", imported: number }` on success or `{ status: "error", message: string }` on failure; tool is registered alongside the other 4 tools in T040

**Checkpoint**: US5 fully testable — bootstrap seeds TimescaleDB idempotently at 50% rate quota.

---

## Phase 9: Polish, Tool Registration & Plugin Entry

**Purpose**: Wire all components into the OpenClaw plugin lifecycle; register tools; write end-to-end integration tests.

### Tool Registration

- [x] T040 Register all 5 OpenClaw tools in `index.ts` via `definePluginEntry` using `openclaw/plugin-sdk/core` — `get_latest_tick`, `get_ob_snapshot`, `get_funding_rate`, `get_ohlcv`, `bootstrap_historical_data`; bind each registration to the corresponding handler from `src/tools/`
- [x] T041 [P] Populate `openclaw.plugin.json` `configSchema` with all overridable knobs — `symbols: string[]` (default: `["BTC/USDT", "ETH/USDT"]`), `obDepth: number` (default: 20), `sampleObEveryMs: number` (default: 10000), `flush.maxRows: number` (default: 1000), `flush.intervalMs: number` (default: 500), `retention.rawTicksDays: number` (default: 7), `rateLimit.binanceRPM: number` (default: 960), `rateLimit.bybitRPM: number` (default: 480); SecretRef-typed credential fields: `binanceApiKey`, `binanceApiSecret`, `bybitApiKey`, `bybitApiSecret` (never logged or returned in tool output per NFR-006)

### Integration Tests

- [x] T042 Write integration test in `test/market-data-ingestion.integration.test.ts` — mock WS server sends a synthetic Binance trade message → `BinanceAdapter.onTick` fires → MemDir write confirmed (real Redis) → `get_latest_tick("BTC/USDT")` returns a `PriceTick` with `timestamp` within 2 seconds
- [x] T043 [P] Integration test: simulate OB delta sequence with injected gap → assert `OrderBookStateMachine` enters `resyncing` status → mock REST snapshot response provided → machine transitions to `live` → `get_ob_snapshot` returns consistent 5-level book
- [x] T044 [P] Integration test: inject 2,500-tick burst into `priceTickBuffer` → mock `batchInsertTicks` → assert mock called exactly twice (at 1,000-row boundary); inject 50 OB rows concurrently → assert 0 OB drops
- [x] T045 [P] Integration test: `HistoricalBootstrap.run()` with real Redis BullMQ queue → verify `quotaFraction: 0.5` is enforced (job throughput halved vs. full quota)

### Plugin Entry Lifecycle

- [x] T046 Complete `index.ts` `definePluginEntry` implementation — `onActivate`: read config, create `MemDir` client from `@openclaw/trading-context`, instantiate `BinanceAdapter` and `BybitAdapter`, instantiate one `OrderBookStateMachine` per configured symbol per exchange, start all `WriteBuffer` instances, call `adapter.connect()` and `adapter.subscribe(symbols)` for both adapters, wire all pipeline callbacks (tick → MemDir + buffer, OB delta → state machine + MemDir + buffer, funding rate → MemDir + buffer); `onDeactivate`: call `adapter.disconnect()` on all adapters, await `stop()` on all three `WriteBuffer` instances to drain, await `closePool()` on the pg client

---

## Dependencies

```
Phase 1 (Setup)
  └─► Phase 2 (Foundational — schemas, WriteBuffer, pg client, BullMQ)
        ├─► Phase 3 (US1 — Adapters + tick pipeline)
        │     └─► Phase 4 (US2 — OB state machine + OB pipeline)
        │           └─► Phase 5 (US6 — WriteBuffer wired to pg inserts)
        │                 ├─► Phase 6 (US3 — Funding rate pipeline)
        │                 └─► Phase 7 (US4 — OHLCV queries)
        └─► Phase 8 (US5 — Bootstrap CLI, depends on BullMQ + pg + queries)
              └─► Phase 9 (Tool registration, integration tests, plugin entry)
```

US1 and US2 can be developed concurrently after Phase 2. US3, US4, and US6 can be developed in parallel after Phase 3+4. US5 can begin after Phase 2 (BullMQ + pg exist) independently of US3/US4.

## Parallel Execution Examples

- T005, T006, T007, T008 can all run in parallel (different schema files, no dependencies)
- T012, T013, T014, T015 can run in parallel (WriteBuffer tests and BullMQ setup are independent)
- T016 and T017 (BinanceAdapter, BybitAdapter) can be built in parallel
- T018 and T019 (adapter tests) can run in parallel after T016/T017 begin
- T034, T035, T036 (OHLCV) can run in parallel with T037, T038, T039 (Bootstrap)
- T042, T043, T044, T045 (integration tests) can all run in parallel

## Implementation Strategy

**MVP scope** (deliver US1 end-to-end as the first shippable increment):

1. T001–T003 (setup)
2. T004, T009, T010, T011 (PriceTick schema + DB client + migration + WriteBuffer)
3. T013, T014 (BullMQ for OB re-snapshot REST calls, needed immediately)
4. T016, T018 (BinanceAdapter + tests)
5. T020, T021, T022 (tick pipeline MemDir write + DB insert + tool)
6. T028, T030 (wire WriteBuffer to pg, drain on deactivate)
7. T040, T046 (tool registration + plugin entry)

After MVP: complete US2 (OB state machine), then US6 (backpressure integration test), then US3/US4 (funding rate + OHLCV), then US5 (bootstrap CLI), then integration tests.

The halt/safety dependencies from `001-advanced-context-memory` (MemDir typed keys, bounded-timeout reads) are consumed here without modification — the trading-context package is a runtime peer dependency.
