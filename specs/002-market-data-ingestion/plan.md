# Implementation Plan: Market Data Ingestion

**Branch**: `002-market-data-ingestion` | **Date**: 2026-04-04 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/002-market-data-ingestion/spec.md`

---

## Summary

Build `@openclaw/market-data-ingestion` — an OpenClaw plugin that ingests real-time market data from Binance and Bybit via WebSocket, normalizes events into typed schemas (PriceTick, OrderBookSnapshot, FundingRate), maintains a per-symbol order book state machine, writes hot-path state to MemDir (Redis, via plugin 001), and batches cold-path persistence into TimescaleDB hypertables with continuous OHLCV aggregates. A BullMQ rate limiter gates all outbound REST calls. A one-time bootstrap CLI backfills historical 1m candle data. Five OpenClaw tools surface the data to the trading agent.

---

## Technical Context

**Language/Version**: TypeScript 5.x, ESM (`"type": "module"`), Node 22+  
**Primary Dependencies**:

- `ws` — WebSocket client for exchange streams (deliberate; no browser environment needed, avoids wrapping native `WebSocket` for reconnect control)
- `bullmq` — Redis-backed queue for REST rate limiting (per-exchange named queues)
- `pg` — PostgreSQL/TimescaleDB client (pool-based; `@types/pg` dev dep)
- `ioredis` — Redis client (already in workspace via `@openclaw/trading-context`; reuse the same instance via MemDir API)
- `zod` — Schema validation at all external ingestion boundaries (exchange WS payloads → normalized types)

**Storage**:

- **MemDir (Redis)** — hot-path real-time state (latest tick, OB snapshot, funding rate); TTL-gated freshness aligned with update cadence; provided by `@openclaw/trading-context` via `createMemDir`
- **TimescaleDB** — cold-path time-series persistence; `price_ticks` hypertable, `ob_snapshots` hypertable, `funding_rates` hypertable, continuous aggregates for 1m/5m/1h OHLCV; retention policies enforced by TimescaleDB scheduler

**Testing**: Vitest with V8 coverage; colocated `*.test.ts` files  
**Target Platform**: Linux server (Node 22+; same runtime as the OpenClaw host process)  
**Project Type**: OpenClaw plugin (workspace package under `extensions/`)  
**Performance Goals**: ≤500 ms p99 end-to-end WS→MemDir latency; ≥1,000 combined ticks/sec across all symbols; TimescaleDB writes batched (never individual per-tick inserts)  
**Constraints**: Must not block the OpenClaw host event loop; all I/O async; credentials stored as SecretRef (never logged); backpressure cap at 10,000 pending write events  
**Scale/Scope**: 2 exchanges × N symbols (initial: BTC/USDT, ETH/USDT); plugin is self-contained within `extensions/market-data-ingestion/`

---

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design._

| Principle                               | Status                          | Notes                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I. Real-Time Data Integrity**         | ✅ Required                     | WS reconnect with exponential backoff (base 1s, cap 30s), heartbeat/ping-pong, gap detection + re-snapshot, write buffer never drops OB/Funding rows                                                                                          |
| **II. Quantitative Rigor**              | ✅ Partial (Phase 1 foundation) | This plugin provides the raw data substrate. OB state machine exposes `getMidprice`, `getSpread`, `getImbalance`. Full quant features (RSI, MACD, VWAP) are Phase 3; this plugin just ensures clean, gapless tick data for those computations |
| **III. Fail-Safe Risk Management**      | ✅ N/A this phase               | Ingestion layer does not execute orders; circuit-breaking heuristics are Phase 5. The write buffer's backpressure drop policy (drop only price ticks, never OB/Funding) honors data integrity priority ordering                               |
| **IV. Transparent Decision Journaling** | ✅ N/A this phase               | No agent decisions in this plugin. Data-loss events (tick drops, OB reset, gap detection) are logged at `warn` level per NFR-005                                                                                                              |
| **V. Shared Multi-Agent Context**       | ✅ Required                     | All market state written to MemDir keys (`{exchange}:tick:{symbol}`, `{exchange}:ob:{symbol}`, `{exchange}:funding:{symbol}`) so any agent can read without coupling to ingestion internals                                                   |

**Violations**: None. Complexity justification table not required.

---

## Project Structure

### Documentation artifacts (this feature)

```text
specs/002-market-data-ingestion/
├── plan.md              ← this file
├── research.md          # Phase 0 (resolved clarifications)
├── data-model.md        # Phase 1 (entity definitions + DB schema)
├── quickstart.md        # Phase 1 (dev setup, Docker compose, testnet config)
├── contracts/
│   ├── tools.md         # OpenClaw tool signatures
│   └── memdir-keys.md   # MemDir key contract (keys, TTLs, value shapes)
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created here)
```

### Source code layout

```text
extensions/market-data-ingestion/
├── package.json                        # @openclaw/market-data-ingestion
├── openclaw.plugin.json                # Plugin manifest + configSchema
├── index.ts                            # definePluginEntry — registers tools, starts adapters
├── runtime-api.ts                      # OpenClawPluginApi type alias (mirrors trading-context pattern)
└── src/
    ├── api.ts                          # Public exports surface (re-exports types, createMemDir bridge)
    │
    ├── schema/                         # Zod schemas + inferred TS types — validated at WS boundary
    │   ├── PriceTick.ts
    │   ├── OrderBookSnapshot.ts
    │   ├── FundingRate.ts
    │   └── OHLCV.ts
    │
    ├── adapters/                       # Exchange-specific WS clients
    │   ├── types.ts                    # ExchangeAdapter interface
    │   ├── BinanceAdapter.ts           # Spot + USDT-M Futures streams
    │   ├── BinanceAdapter.test.ts
    │   ├── BybitAdapter.ts             # Spot + Linear streams
    │   └── BybitAdapter.test.ts
    │
    ├── ob/                             # Order book state machine
    │   ├── OrderBookStateMachine.ts    # Apply deltas, gap detection, re-snapshot
    │   └── OrderBookStateMachine.test.ts
    │
    ├── db/                             # TimescaleDB persistence
    │   ├── client.ts                   # pg Pool singleton (lazy-init, configurable URL)
    │   ├── WriteBuffer.ts              # Batching insert buffer (flush on maxRows OR timer)
    │   ├── WriteBuffer.test.ts
    │   ├── queries.ts                  # OHLCV query helpers (get_ohlcv tool backing)
    │   └── migrations/
    │       └── 001_initial.sql         # Hypertables, compression, cont. aggregates, retention
    │
    ├── ratelimit/                      # BullMQ-gated REST calls
    │   ├── queues.ts                   # Queue definitions: trading:ratelimit:binance/bybit
    │   └── rest.ts                     # Typed REST wrapper that enqueues via BullMQ
    │
    ├── bootstrap/                      # One-time historical backfill
    │   ├── HistoricalBootstrap.ts      # Idempotent fetch + insert; uses BullMQ at 50% quota
    │   └── HistoricalBootstrap.test.ts
    │
    └── tools/                          # OpenClaw tool handler implementations
        ├── get-latest-tick.ts
        ├── get-ob-snapshot.ts
        ├── get-funding-rate.ts
        ├── get-ohlcv.ts
        └── bootstrap-historical-data.ts
```

**Structure Decision**: Single plugin package under `extensions/` following the established `trading-context` pattern. No separate `backend/` root — the plugin is a self-contained workspace package. Tests colocated with source (`*.test.ts`) following repo convention.

---

## Architecture Decisions

### 1. Adapter Pattern — `ExchangeAdapter` interface

Each exchange implements a common interface. The plugin entry (`index.ts`) instantiates one adapter per exchange, calls `connect()` and `subscribe(symbols)`, and attaches the normalized event callbacks. Adapters handle all exchange-specific quirks (stream URL construction, message envelope parsing, ping-pong framing) internally, emitting only validated normalized types to the rest of the system.

**Binance dual connection**: `BinanceAdapter` opens two internal `ws.WebSocket` connections — one to `wss://stream.binance.com:9443` (Spot streams) and one to `wss://fstream.binance.com` (USDT-M Futures streams). Both connections share the same reconnect/heartbeat policy. `BybitAdapter` uses a single connection to `wss://stream.bybit.com/v5/public` and subscribes to both Spot and Linear topics on the same socket.

**Why `ws` package**: Gives explicit control over ping/pong intervals and reconnect logic. The adapter holds a `ws.WebSocket` instance, schedules a 10-second heartbeat timer, and calls its own `reconnect()` on timeout or close events. This is clearer than wrapping the browser `WebSocket` prototype for reconnect semantics.

**Reconnect policy**: Exponential backoff starting at 1 second, doubling each attempt, capped at 30 seconds, with ±25% jitter to avoid thundering-herd on exchange outages.

**Dead connection detection**: A `setInterval` at 10 seconds checks whether any message has arrived. If not, a `ws.ping()` is sent; if no `pong` is received within 5 seconds, `reconnect()` is called.

### 2. Order Book State Machine

A single `OrderBookStateMachine` class is instantiated per `(exchange, symbol)` pair. It maintains:

- Bids and asks stored in `Map<number, number>` (price → qty); queries sort on read via `Array.from(map.entries()).sort()` since JS `Map` does not maintain numeric sort order. If profiling shows this is a bottleneck at high tick rates, swap to a sorted array or B-tree structure.
- `lastSequenceId: number` to detect gaps
- `status: "uninitialized" | "snapshotting" | "live" | "resyncing"`

**State transitions**:

```
UNINITIALIZED
  → [fetchSnapshot succeeds]
SNAPSHOTTING → LIVE
  → [delta arrives with gap ( seqId !== lastSeq + 1 )]
LIVE → RESYNCING
  → [fetchSnapshot succeeds + pending deltas replayed]
RESYNCING → LIVE
  → [fetchSnapshot fails (retried via adapter backoff)]
```

**Delta application**: Deltas arriving while `status === "resyncing"` are buffered in a queue and replayed in order once a new snapshot is established. Deltas with `qty === 0` remove the price level. Duplicates (`seqId <= lastSequenceId`) are silently discarded.

**External reads**: `getTopOfBook(depth)`, `getMidprice()`, `getSpread()`, `getImbalance(depth)` return `undefined` (not an error object) when `status !== "live"`, signaling "not yet ready" to tool handlers without throwing.

### 3. Write Buffer — Batching TimescaleDB Inserts

A generic `WriteBuffer<T>` class accepts row objects and flushes them via a supplied `insert(rows: T[]) => Promise<void>` callback. It is instantiated once per hypertable:

- `WriteBuffer<PriceTick>` — max 1,000 rows, flush interval 500 ms
- `WriteBuffer<OrderBookSnapshot>` — max 1,000 rows, flush interval 500 ms (sampled: only every 10 s per symbol, so inflow is naturally low)
- `WriteBuffer<FundingRate>` — max 1,000 rows, flush interval 500 ms (inflow is very low)

**Flush trigger**: whichever comes first — `buffer.length >= maxRows` or `Date.now() - lastFlushAt >= flushIntervalMs`.

**Backpressure**: Each `WriteBuffer` has a `maxQueueDepth` (default 10,000). When `push()` is called and `buffer.length >= maxQueueDepth`, the buffer drops the oldest enqueued row and logs a warning with the running drop count. `WriteBuffer<OrderBookSnapshot>` and `WriteBuffer<FundingRate>` set `maxQueueDepth = Infinity` (no drops allowed per FR-023).

**Lifecycle**: `start()` begins the interval timer; `stop()` clears the timer and flushes remaining rows before the plugin deactivates.

### 4. MemDir Integration — Hot-Path Real-Time State

The plugin does **not** own a Redis connection directly. It calls `createMemDir({ client: getRedisClient() })` from `@openclaw/trading-context` — the same Redis client that plugin 001 uses. This avoids a second connection to the same Redis instance.

Every normalized event triggers an immediate `memDir.set()` before being pushed to the write buffer:

```
tick arrived
  → validate with zod schema
  → write to MemDir key binance:tick:BTC/USDT (ttl: 5000 ms)
  → push to WriteBuffer<PriceTick>        [async, does not block WS handler]
```

MemDir writes happen synchronously on the event loop tick (Redis command enqueued to ioredis pipeline); they do not await the write buffer flush. This ensures the hot path (agent reads via tool) is always current even if the TimescaleDB batch has not yet flushed.

### 5. BullMQ Rate Limiter — REST-Only Gating

Two BullMQ queues are created at plugin startup:

- `trading:ratelimit:binance` — 960 jobs/min cap (80% of 1,200)
- `trading:ratelimit:bybit` — 480 jobs/min cap (80% of 600)

Every outbound REST call (historical bootstrap, OB re-snapshot fetch, funding rate REST poll) is wrapped in `rateLimitedRest(exchange, fn)` which enqueues a job and resolves the Promise when the job runs. WebSocket connections bypass BullMQ entirely.

**Bootstrap mode**: The bootstrap CLI passes a `quotaFraction: 0.5` option, instructing the wrapper to use 50% of the normal cap (per FR-029).

**Redis unavailability fallback**: If BullMQ cannot connect to Redis at queue creation time, the plugin falls back to an in-process `TokenBucketQueue` that enforces the same per-exchange rate caps (960/480 RPM) using a simple token-bucket algorithm, and logs a warning. This ensures exchange rate limits are still respected even without Redis (per edge-case spec).

---

## Data Flow

```
Exchange WebSocket
        │
        ▼
[BinanceAdapter | BybitAdapter]
   - parse raw WS message
   - validate with Zod schema
   - emit normalized event
        │
        ├──► MemDir.set(key, value, ttl)   ← HOT PATH (immediate, async-enqueued)
        │         │
        │         └── Redis: binance:tick:BTC/USDT
        │                    binance:ob:BTC/USDT
        │                    binance:funding:BTC/USDT
        │
        ├──► OrderBookStateMachine.applyDelta(delta)
        │         │
        │         └── triggers MemDir.set for OB on state change
        │
        └──► WriteBuffer.push(row)          ← COLD PATH (batched)
                  │
                  └── [on flush: 1000 rows OR 500ms]
                            │
                            ▼
                      pg.query(INSERT INTO price_ticks ...)
                      pg.query(INSERT INTO ob_snapshots ...)
                      pg.query(INSERT INTO funding_rates ...)
                            │
                            ▼
                      TimescaleDB
                      ├── price_ticks (hypertable, 7d retention)
                      ├── ob_snapshots (hypertable, 30d retention)
                      ├── funding_rates (hypertable, 90d retention)
                      └── Continuous Aggregates
                          ├── ohlcv_1m  (90d retention)
                          ├── ohlcv_5m  (90d retention)
                          └── ohlcv_1h  (indefinite)

Tool call: get_latest_tick("BTC/USDT")
        │
        └──► MemDir.get("binance:tick:BTC/USDT")   ← reads hot path, no DB query

Tool call: get_ohlcv("BTC/USDT", "1h", 168)
        │
        └──► pg.query FROM ohlcv_1h WHERE ...       ← reads cold path TimescaleDB

REST bootstrap path (via BullMQ):
exchange REST API → [BullMQ queue] → HistoricalBootstrap → WriteBuffer → TimescaleDB
```

---

## Key Interfaces

### `ExchangeAdapter` (`src/adapters/types.ts`)

```typescript
export interface ExchangeAdapter {
  readonly exchange: "binance" | "bybit";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(symbols: string[]): Promise<void>;
  onTick(cb: (tick: PriceTick) => void): void;
  onOBSnapshot(cb: (snap: OrderBookSnapshot) => void): void;
  onOBDelta(cb: (delta: OBDelta) => void): void;
  onFundingRate(cb: (rate: FundingRate) => void): void;
}
```

### `OrderBookStateMachine` (`src/ob/OrderBookStateMachine.ts`)

```typescript
export class OrderBookStateMachine {
  constructor(exchange: string, symbol: string);
  applySnapshot(snap: OrderBookSnapshot): void;
  applyDelta(delta: OBDelta): void; // triggers re-snapshot internally on gap
  getStatus(): "uninitialized" | "snapshotting" | "live" | "resyncing";
  getTopOfBook(depth: number): { bids: Level[]; asks: Level[] } | undefined;
  getMidprice(): number | undefined;
  getSpread(): number | undefined;
  getImbalance(depth: number): number | undefined; // (bidVol - askVol) / (bidVol + askVol)
  toSnapshot(depth: number): OrderBookSnapshot | undefined;
}
```

### `WriteBuffer<T>` (`src/db/WriteBuffer.ts`)

```typescript
export interface WriteBufferOptions<T> {
  maxRows: number; // flush when buffer reaches this length
  flushIntervalMs: number; // flush every N ms regardless
  maxQueueDepth: number; // drop oldest rows when queue exceeds this (use Infinity to disable)
  label: string; // log prefix for warnings
  insert: (rows: T[]) => Promise<void>;
}

export class WriteBuffer<T> {
  constructor(opts: WriteBufferOptions<T>);
  push(row: T): void;
  start(): void;
  stop(): Promise<void>; // flush remaining before resolving
}
```

### Plugin Config Schema (`openclaw.plugin.json`)

```json
{
  "id": "market-data-ingestion",
  "kind": "plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "binanceApiKey": { "type": "string", "$ref": "SecretRef" },
      "binanceApiSecret": { "type": "string", "$ref": "SecretRef" },
      "bybitApiKey": { "type": "string", "$ref": "SecretRef" },
      "bybitApiSecret": { "type": "string", "$ref": "SecretRef" },
      "redisUrl": { "type": "string", "description": "Defaults to redis://localhost:6379" },
      "postgresUrl": {
        "type": "string",
        "$ref": "SecretRef",
        "description": "TimescaleDB connection string"
      },
      "symbols": {
        "type": "array",
        "items": { "type": "string" },
        "description": "e.g. [\"BTC/USDT\",\"ETH/USDT\"]"
      },
      "obDepth": { "type": "number", "description": "Default OB depth (default: 5)" },
      "obSampleIntervalMs": {
        "type": "number",
        "description": "How often to persist OB snapshot to DB (default: 10000)"
      },
      "writeBufferMaxRows": { "type": "number", "description": "Flush threshold (default: 1000)" },
      "writeBufferFlushMs": { "type": "number", "description": "Flush interval ms (default: 500)" },
      "reconnectBaseMs": {
        "type": "number",
        "description": "WS reconnect base delay ms (default: 1000)"
      },
      "reconnectCapMs": {
        "type": "number",
        "description": "WS reconnect cap delay ms (default: 30000)"
      },
      "heartbeatIntervalMs": {
        "type": "number",
        "description": "WS heartbeat check interval ms (default: 10000)"
      }
    }
  }
}
```

---

## Dependencies

### New `dependencies` (runtime, `extensions/market-data-ingestion/package.json`)

| Package  | Version   | Purpose                                   |
| -------- | --------- | ----------------------------------------- |
| `ws`     | `^8.18.0` | WebSocket client for exchange streams     |
| `bullmq` | `^5.x`    | Redis-backed queue for REST rate limiting |
| `pg`     | `^8.x`    | PostgreSQL/TimescaleDB pool client        |

### New `devDependencies`

| Package     | Version | Purpose                   |
| ----------- | ------- | ------------------------- |
| `@types/ws` | `^8.x`  | TypeScript types for `ws` |
| `@types/pg` | `^8.x`  | TypeScript types for `pg` |

### Reused from workspace (declare in `devDependencies` / `peerDependencies`, resolved at runtime)

| Package    | Source                          | Usage                                                                         |
| ---------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `ioredis`  | `@openclaw/trading-context` dep | Redis client passed in via `createMemDir` — do not create a second connection |
| `zod`      | `@openclaw/trading-context` dep | Schema validation; declare in `dependencies` for self-containment             |
| `openclaw` | workspace `*`                   | Plugin SDK (`openclaw/plugin-sdk/plugin-entry`, `openclaw/plugin-sdk/core`)   |

**Note on `ioredis`**: The plugin calls `getRedisClient()` imported from `@openclaw/trading-context` to reuse the existing connection. It does not declare `ioredis` as its own dependency — the client is obtained via the plugin 001 API surface.

---

## Test Strategy

### Unit Tests (colocated `*.test.ts`)

| File                                   | What to test                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ob/OrderBookStateMachine.test.ts` | Apply snapshot; apply sequential deltas; gap triggers `resyncing`; duplicate seqId discarded; `getMidprice`/`getSpread`/`getImbalance` math; reads return `undefined` when not live                           |
| `src/db/WriteBuffer.test.ts`           | Flush fires on `maxRows`; flush fires on timer; timer reset after manual flush; `stop()` flushes remainder; backpressure drops oldest rows; logs warn with drop count; OB buffer never drops (Infinity depth) |
| `src/schema/*.ts`                      | Zod parse valid shapes; Zod parse rejects missing required fields; side enum validation                                                                                                                       |

### Adapter Tests — Mock WS Server

Use the `ws` package's `WebSocket.Server` to run an in-process mock exchange server. Each test:

1. Starts the mock server on a random port
2. Instantiates the adapter pointed at `ws://localhost:<port>`
3. Sends crafted WS frames (trade event, depth update, ping frame)
4. Asserts normalized events emitted by the adapter
5. Simulates close → asserts the adapter reconnects within the backoff window

**Files**: `src/adapters/BinanceAdapter.test.ts`, `src/adapters/BybitAdapter.test.ts`

### Bootstrap Tests — Mock REST + pg

`src/bootstrap/HistoricalBootstrap.test.ts`:

- Mock `pg.Pool.query` to return a max timestamp (idempotency check)
- Assert only missing time range is fetched
- Assert BullMQ quota is halved in bootstrap mode
- Assert `upsert` semantics on conflict

### Integration Tests — Real Redis (test instance)

`src/adapters/BinanceAdapter.test.ts` (integration tag):

- Spin a Redis instance via `@testcontainers/redis` or require `REDIS_URL` env
- Run a full adapter→MemDir write cycle
- Assert MemDir key is set with correct value and TTL

### TimescaleDB Tests

TimescaleDB integration tests use a Docker container via `@testcontainers/postgresql` with the `timescale/timescaledb:latest-pg16` image. The 001_initial.sql migration is applied at container start. Tests that exercise batch inserts, continuous aggregates, and OHLCV queries run against this real TimescaleDB instance. For unit tests (WriteBuffer, query builders), mock the `pg.Pool.query` function — no live DB needed.

### Performance Test

`src/db/WriteBuffer.perf.test.ts`:

- Simulate 5,000 `push()` calls within 200 ms
- Assert `insert` mock was called ≤ 3 times (flush at 1,000 + 1,000 + 500 ms remainder)
- Assert zero dropped rows (5,000 < 10,000 backpressure limit)

---

## Complexity Tracking

_No Constitution violations requiring justification._

---

## Open Questions / Risks

| #   | Question                                                                                    | Resolution approach                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does Bybit's `orderbook.50` stream supply sequence IDs suitable for gap detection?          | Confirm from Bybit API docs during Phase 0 research; Bybit uses `u` (update ID) field analogous to Binance's `U`/`u` range                                                |
| 2   | TimescaleDB continuous aggregate materialization lag — will OHLCV be stale for recent data? | Use `WITH (timescaledb.materialized_only = false)` on aggregate views to query both materialized + real-time; document in `quickstart.md`                                 |
| 3   | BullMQ job serialization: can closures be passed as job payloads?                           | No — BullMQ jobs must be JSON-serializable. Pattern: enqueue a job descriptor `{ exchange, endpoint, params }` and the worker function reconstructs the REST call from it |
| 4   | Re-snapshot REST calls for OB gap recovery: are these subject to the rate limiter?          | Yes — OB re-snapshot via REST goes through the BullMQ queue. To avoid blocking the re-snapshot behind a full queue, use BullMQ `priority: 1` (high) for gap-recovery jobs |
| 5   | `pnpm-workspace.yaml` — does the new package need to be added?                              | Check workspace glob; `extensions/*` likely already included. Verify before wiring up                                                                                     |
