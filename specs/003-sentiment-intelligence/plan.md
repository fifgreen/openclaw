# Implementation Plan: Sentiment Intelligence

**Branch**: `003-sentiment-intelligence` | **Date**: 2026-04-05 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/003-sentiment-intelligence/spec.md`

---

## Summary

Build `@openclaw/sentiment-intelligence` — an OpenClaw plugin that ingests non-price sentiment signals from multiple sources (Fear & Greed Index, Twitter/Nitter, Reddit JSON API, CryptoPanic, CoinGecko), pulls geoeconomic macro series from FRED and CoinMarketCap, classifies crypto news headlines via a keyword-and-prompt NLP pipeline, computes a composite sentiment snapshot per symbol, and stores hot-path state in MemDir (Redis, via `@openclaw/trading-context`) and cold-path data in TimescaleDB hypertables. An async BullMQ worker serializes snapshots and submits them to Ollama (`nomic-embed-text`) for 768-dim vector storage in pgvector. A per-feed health monitor scores staleness every 5 minutes; a 30-day rolling accuracy tracker compares feed predictions against trade outcomes. Four OpenClaw tools surface all signals to the trading agent with sub-200 ms latency.

---

## Technical Context

**Language/Version**: TypeScript 5.x, ESM (`"type": "module"`), Node 22+  
**Primary Dependencies**:

- `axios` — HTTP client for polling external REST APIs (Fear & Greed, CryptoPanic, CoinGecko, FRED, CoinMarketCap, Reddit JSON API, Ollama, Twitter API v2); chosen over `fetch` for consistent timeout / retry / interceptor support across Node 22+ and Bun
- `bullmq` — Redis-backed scheduled workers for all poll crons and the embedding queue; ensures cron jobs survive gateway restarts; shared BullMQ instance with `002-market-data-ingestion`
- `ioredis` — Redis client; reused via `@openclaw/trading-context` MemDir API — no second connection created
- `zod` — Schema validation at ALL external API response boundaries (feed payloads, Ollama embedding response, FRED observations); declared in `dependencies` for self-containment
- Ollama REST API — `nomic-embed-text` 768-dim embeddings via HTTP POST to `http://localhost:11434/api/embeddings`; preferred over `@xenova/transformers` since Ollama is already part of the planned infrastructure

**Storage**:

- **MemDir (Redis)** — hot path for real-time sentiment snapshots (`sentiment:composite:{symbol}`, `sentiment:composite:global`) with 4 h TTL, and macro context (`sentiment:macro:context`) with 24 h TTL; provided by `@openclaw/trading-context` via `createMemDir`; all `get_sentiment()` and `get_macro_context()` tool calls read exclusively from MemDir
- **TimescaleDB** — cold path for `sentiment_snapshots` (hypertable), `news_events` (hypertable), `macro_snapshots` (regular table, upsert by `(seriesId, effectiveDate)`), and `feed_accuracy` (regular table); pg Pool reused from `@openclaw/market-data-ingestion`
- **pgvector (same TimescaleDB instance)** — `sentiment_embeddings` table with 768-dim `vector` column; populated async post-snapshot by the embedding BullMQ worker; queried by Phase 4 RAG pipeline

**Testing**: Vitest with V8 coverage; colocated `*.test.ts` files  
**Target Platform**: Linux server (Node 22+; same runtime as the OpenClaw host process)  
**Project Type**: OpenClaw plugin (workspace package under `extensions/`)  
**Performance Goals**: `get_sentiment()` ≤100 ms p99; `get_macro_context()` ≤200 ms p99; `get_news_events()` ≤500 ms p99 (DB query); all goals met via MemDir-first read strategy  
**Constraints**: All BullMQ workers must survive gateway restarts; credentials stored as SecretRef (never logged); polling may not block the host event loop; TimescaleDB writes queued (up to 1,000 rows) when DB unavailable  
**Scale/Scope**: 2–5 configured symbols (default: BTC, ETH); plugin is self-contained within `extensions/sentiment-intelligence/`

---

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design._

| Principle                               | Status      | Notes                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I. Real-Time Data Integrity**         | ✅ Required | BullMQ `RepeatableJob` definitions registered idempotently at startup survive gateway restarts; MemDir TTLs (4 h sentiment, 24 h macro) gate freshness — data older than TTL is unavailable rather than silently stale; feed staleness checked every 5 min                  |
| **II. Quantitative Rigor**              | ✅ Required | All scores normalized to [0, 1] before MemDir write (clamped + logged if out of range); `compositeScore` is explicit weighted average with documented default weights (F&G 30%, Twitter 30%, Reddit 30%, Funding 10%); accuracy scoring per feed over 30-day rolling window |
| **III. Fail-Safe Risk Management**      | ✅ Required | Graceful degradation: stale feed excluded from composite score, weight redistributed to healthy feeds; Ollama unavailable → embedding queue retries, hot path unaffected; TimescaleDB unavailable → MemDir writes continue, DB writes queued in memory (≤1,000 rows)        |
| **IV. Transparent Decision Journaling** | ✅ Required | `get_feed_accuracy()` exposes per-feed `accuracy30d`, `isStale`, and `weight` to the agent so it can reason about signal reliability; `classificationConfidence` stored per news headline so agent can filter low-confidence classifications                                |
| **V. Shared Multi-Agent Context**       | ✅ Required | All sentiment snapshots and macro context written to MemDir under documented key schema — any agent can read without coupling to ingestion internals; embedding vectors stored with metadata for Phase 4 RAG retrieval                                                      |

**Violations**: None. Complexity justification table not required.

---

## Project Structure

### Documentation artifacts (this feature)

```text
specs/003-sentiment-intelligence/
├── plan.md              ← this file
├── research.md          # Phase 0 (resolved clarifications)
├── data-model.md        # Phase 1 (entity definitions + DB schema)
├── quickstart.md        # Phase 1 (dev setup, Ollama model pull, API key config)
├── contracts/
│   ├── tools.md         # OpenClaw tool signatures + return types
│   └── memdir-keys.md   # MemDir key contract (keys, TTLs, value shapes)
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created here)
```

### Source code layout

```text
extensions/sentiment-intelligence/
├── package.json                        # @openclaw/sentiment-intelligence
├── openclaw.plugin.json               # Plugin manifest + configSchema
├── index.ts                           # definePluginEntry — tool registration + plugin lifecycle
├── runtime-api.ts                     # OpenClawPluginApi type alias
└── src/
    ├── api.ts                         # Public exports surface
    ├── schema/                        # Zod schemas: SentimentSnapshot, MacroSnapshot, NewsEvent, FundingBias
    │   ├── SentimentSnapshot.ts
    │   ├── MacroSnapshot.ts
    │   ├── NewsEvent.ts
    │   └── FeedAccuracy.ts
    ├── feeds/                         # Individual feed implementations
    │   ├── types.ts                   # IFeed interface
    │   ├── FearGreedFeed.ts           # alternative.me polling
    │   ├── TwitterFeed.ts             # Twitter API v2 / Nitter fallback
    │   ├── RedditFeed.ts              # Reddit JSON API (no auth required)
    │   ├── CryptoPanicFeed.ts         # News headlines
    │   └── FredFeed.ts               # FRED macro series + CoinMarketCap + calendars
    ├── sentiment/                     # Sentiment aggregation + derivation
    │   ├── aggregator.ts             # Combines feed outputs into SentimentSnapshot
    │   ├── funding-bias.ts           # Derives long/short bias from FundingRate MemDir key
    │   └── regime-classifier.ts      # risk-on / risk-off / neutral / uncertain classification
    ├── news/                          # News classification
    │   ├── classifier.ts             # Keyword + Ollama prompt classification
    │   └── deduplicator.ts           # Normalized-title + 5-min bucket fingerprint dedup
    ├── macro/                         # Macro data management
    │   └── MacroScheduler.ts         # BullMQ RepeatableJobs for FRED, CoinMarketCap, FOMC, CPI
    ├── embedding/                     # pgvector embedding pipeline
    │   ├── serializer.ts             # Converts SentimentSnapshot / MacroSnapshot to text chunk
    │   └── EmbeddingPipeline.ts      # BullMQ consumer: serialize → Ollama embed → pgvector upsert
    ├── db/                           # DB interaction
    │   ├── migrations/
    │   │   └── 001_initial.sql       # sentiment_snapshots, news_events, macro_snapshots,
    │   │                             # feed_accuracy, sentiment_embeddings (pgvector) tables
    │   └── queries.ts               # DB query helpers (insert, upsert, select)
    ├── health/                        # Feed health + accuracy scoring
    │   ├── HealthMonitor.ts          # BullMQ cron: per-feed staleness checker + alerter
    │   └── AccuracyScorer.ts         # Appends accuracy score per trade outcome event
    └── tools/                         # OpenClaw tool handler implementations
        ├── get-sentiment.ts
        ├── get-macro-context.ts
        ├── get-news-events.ts
        └── get-feed-accuracy.ts
```

**Structure Decision**: Single plugin package under `extensions/` following the established `market-data-ingestion` pattern. No separate `backend/` root — the plugin is a self-contained workspace package. Tests colocated with source (`*.test.ts`) following repo convention.

---

## Architecture Decisions

### 1. Feed Interface Pattern — `IFeed`

Each data source implements a common interface. The plugin entry (`index.ts`) registers one BullMQ `RepeatableJob` per feed at startup via the feed's `schedule` property. When a job fires, the worker calls `feed.poll()`, validates the response with Zod, and passes the result to the `SentimentAggregator` or `MacroScheduler` depending on feed type.

```typescript
// src/feeds/types.ts
export interface IFeed<T> {
  readonly feedId: string;
  readonly schedule: string; // cron expression
  poll(): Promise<T>; // throws on unrecoverable error; logs + returns cached on transient
}
```

**Why polling via BullMQ instead of `setInterval`**: BullMQ `RepeatableJob` definitions are persisted in Redis. If the gateway restarts between polls, the job fires at the correct next time rather than starting a fresh interval from zero. This is the same pattern used by `002-market-data-ingestion` REST rate-limit queues.

**Reconnect / retry policy**: Each feed's BullMQ job uses `attempts: 3` with exponential backoff (base 5 s, cap 60 s). After 3 failed attempts, the job moves to the failed state and the `HealthMonitor` detects staleness at its next 5-minute cron tick.

### 2. Sentiment Aggregation — Composite Score

`SentimentAggregator` (in `src/sentiment/aggregator.ts`) is called by each poll worker after updating its sub-score in MemDir. It reads all sub-scores from MemDir, checks freshness (TTL presence), excludes stale feeds, redistributes weights proportionally, and writes a new `SentimentSnapshot` to MemDir and pushes a row to the TimescaleDB write queue.

**Weight redistribution**: Default weights are F&G 30%, Twitter 30%, Reddit 30%, Funding Bias 10%. When a feed is stale, its weight is set to 0 and the remaining weights are scaled so they sum to 1. Redistribution is computed at write time, not stored configuration — it reflects live feed health.

**Composite score clamping**: Before writing to MemDir, `compositeScore` and all sub-scores are clamped to [0, 1] via `Math.max(0, Math.min(1, score))`. If clamping fires, a `warn` log is emitted with the pre-clamp value.

### 3. Feed Implementations — Source-Specific Clients

**FearGreedFeed**: `GET https://api.alternative.me/fng/?limit=1` via `axios`. No auth. Response validated with Zod (`{ data: [{ value: string, value_classification: string }] }`). Score normalized: `normalizedScore = Number(value) / 100`. Poll every 4 h.

**TwitterFeed**: `GET https://api.twitter.com/2/tweets/search/recent?query={symbol}+crypto&max_results=100` with Bearer token. Per-tweet sentiment derived from keyword scoring (bullish/bearish term lists). Rolling 4 h window mean. If Bearer token is absent or the API returns 429/403, the feed gracefully disables itself (logs `warn`, marks stale) rather than throwing. Nitter fallback base URL is configurable; if provided, axios GET `{nitterBase}/{symbol}/search.json` substitutes.

**RedditFeed**: `GET https://www.reddit.com/r/{subreddit}/hot.json?limit=25` — no auth required. Scans `r/CryptoCurrency` and `r/Bitcoin`. Post title sentiment is scored via keyword matching (same term lists as Twitter). Per-symbol filter: post must mention the symbol in title or flair. Aggregated to 4 h rolling mean. No PRAW required.

**CryptoPanicFeed**: `GET https://cryptopanic.com/api/v1/posts/?auth_token={key}&public=true&currencies={symbol}`. Response headlines passed to `src/news/classifier.ts`. Poll every 30 min.

**FredFeed**: Handles all FRED series (`DTWEXBGS` for DXY, `DGS10` for US10Y, `M2SL` for M2, `DCOILWTICO` for WTI) plus CoinMarketCap global stats, plus HTML scrape for FOMC and CPI calendars. Series pulled daily; calendars weekly.

### 4. News Classification — Keyword + Ollama Fallback

`src/news/classifier.ts` uses a two-tier approach:

**Tier 1 — Keyword rules** (synchronous, no I/O):

- Impact class: keyword sets for `regulatory` (SEC, CFTC, ban, law), `hack` (exploit, stolen, breach), `institutional` (ETF, hedge fund, treasury), `technical` (upgrade, fork, testnet), `macro` (Fed, interest rate, CPI, GDP)
- Sentiment: positive/negative term lists; default `neutral` if ambiguous
- `classificationConfidence` set to `0.9` for strong keyword hit, `0.65` for partial match

**Tier 2 — Ollama prompt classification** (async, only if Tier 1 confidence < 0.6):
A structured prompt is submitted to the configured Ollama model. Response is parsed from JSON. On parse failure or Ollama unavailability, the Tier 1 result is used as-is with `classificationConfidence` preserved.

This design keeps the critical path fast (most headlines are classified in <1 ms by Tier 1) while maintaining quality for ambiguous inputs.

### 5. Macro Layer — `MacroScheduler`

`MacroScheduler` (`src/macro/MacroScheduler.ts`) registers BullMQ `RepeatableJob`s at plugin startup:

- Daily: FRED series pull (DXY, US10Y, M2, WTI), CoinMarketCap global stats
- Weekly: FOMC meeting calendar scrape, CPI release calendar scrape

After each successful pull, the scheduler upserts rows into `macro_snapshots` (keyed on `(seriesId, effectiveDate)`) and calls `buildMacroContext()` which reads the latest row per series, applies regime classification rules, and writes the resulting `MacroContext` to MemDir key `sentiment:macro:context` with 24 h TTL.

**Regime classification** (`src/sentiment/regime-classifier.ts`):

- `risk_off` if DXY > 104 AND US10Y > 4.5 AND `fomcLastAction === "hike"`
- `risk_on` if DXY < 100 AND US10Y < 3.5
- `uncertain` if any required series is missing or `effectiveDate` > 48 h ago
- `neutral` otherwise

Rules are configurable via plugin config; the classifier accepts an override rule set.

### 6. Embedding Pipeline — Async BullMQ Worker

The embedding pipeline is fully decoupled from the sentiment poll critical path.

**Write path**: After a `SentimentSnapshot` or `MacroContext` is written to TimescaleDB, the poll worker enqueues a lightweight job `{ type: "sentiment" | "macro", id: number, timestamp: string }` to the `sentiment:embed` BullMQ queue. The poll worker does not wait for embedding.

**Embedding worker** (`src/embedding/EmbeddingPipeline.ts`):

1. Reads the snapshot row from TimescaleDB by `id`
2. Calls `serializer.ts` to produce a human-readable text chunk
3. POSTs to Ollama: `POST /api/embeddings { model: "nomic-embed-text", prompt: textChunk }`
4. Validates response with Zod (`{ embedding: number[] }`)
5. Upserts into `sentiment_embeddings` on composite key `(type, timestamp, symbols)`

**Retry policy**: `attempts: 5`, exponential backoff base 5 s, cap 5 min. If Ollama is unreachable, the job retries silently. `get_sentiment()` and `get_macro_context()` are never blocked.

**Serializer format** (example for sentiment):

```text
Sentiment snapshot 2026-04-05T12:00:00Z BTC:
Fear & Greed: 0.42 (fear). Twitter score: 0.55 (slightly bullish, 1200 tweets).
Reddit score: 0.48 (neutral, 340 posts). Funding bias: long (rate: 0.012%).
Composite: 0.50 (neutral). Regime: neutral.
```

### 7. MemDir Integration — Hot-Path Read Strategy

The plugin does **not** own a Redis connection directly. It calls `createMemDir({ client: getRedisClient() })` from `@openclaw/trading-context` — the same Redis client used by plugins 001 and 002.

**Key schema**:

| Key                                  | Written by            | TTL  | Value shape                                                   |
| ------------------------------------ | --------------------- | ---- | ------------------------------------------------------------- |
| `sentiment:composite:{symbol}`       | `SentimentAggregator` | 4 h  | `SentimentSnapshot` JSON                                      |
| `sentiment:composite:global`         | `SentimentAggregator` | 4 h  | `SentimentSnapshot` JSON (market-wide)                        |
| `sentiment:macro:context`            | `MacroScheduler`      | 24 h | `MacroContext` JSON                                           |
| `sentiment:subfeed:fear_greed`       | `FearGreedFeed`       | 5 h  | `{ score: number, label: string, lastUpdated: string }`       |
| `sentiment:subfeed:twitter:{symbol}` | `TwitterFeed`         | 5 h  | `{ score: number, tweetVolume: number, lastUpdated: string }` |
| `sentiment:subfeed:reddit:{symbol}`  | `RedditFeed`          | 5 h  | `{ score: number, postVolume: number, lastUpdated: string }`  |
| `sentiment:health:{feedId}`          | `HealthMonitor`       | —    | `{ lastSuccessfulPoll: string, isStale: boolean }`            |

Sub-feed keys are written immediately by each poll worker after its individual poll. The aggregator reads all sub-feed keys to compute the composite.

### 8. Feed Health Monitor — Staleness Detection

`HealthMonitor` (`src/health/HealthMonitor.ts`) runs as a BullMQ `RepeatableJob` every 5 minutes. For each registered feed it:

1. Reads `sentiment:health:{feedId}` from MemDir
2. Computes staleness: `isStale = (now - lastSuccessfulPoll) > 2 × scheduledIntervalMs`
3. If `isStale` transitions to `true`: emits `warn` log, sends OpenClaw channel alert with `{ feedId, lastSuccessfulPoll, staleDurationMinutes }`
4. If `isStale` transitions to `false` (recovery): emits `info` log

**Accuracy scorer** (`src/health/AccuracyScorer.ts`): listens for trade-outcome events sourced from the execution layer (Phase 5 hook). On each event, for each active sentiment feed, it reads the sub-score at trade-entry time (from TimescaleDB `sentiment_snapshots`), compares predicted direction against outcome, and inserts a row into `feed_accuracy`. The accuracy scorer is passive until Phase 5 provides the hook — `feed_accuracy` remains empty and `get_feed_accuracy()` returns `accuracy30d: null` and `weight: 1.0` for all feeds.

### 9. Plugin Config Schema

```json
{
  "id": "sentiment-intelligence",
  "kind": "plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "twitterBearerToken": { "type": "string", "$ref": "SecretRef" },
      "nitterBaseUrl": { "type": "string", "description": "Optional Nitter fallback base URL" },
      "fredApiKey": { "type": "string", "$ref": "SecretRef" },
      "coinMarketCapApiKey": { "type": "string", "$ref": "SecretRef" },
      "cryptoPanicApiKey": { "type": "string", "$ref": "SecretRef" },
      "postgresUrl": { "type": "string", "$ref": "SecretRef" },
      "redisUrl": { "type": "string", "description": "Defaults to redis://localhost:6379" },
      "ollamaBaseUrl": { "type": "string", "description": "Defaults to http://localhost:11434" },
      "ollamaEmbedModel": { "type": "string", "description": "Defaults to nomic-embed-text" },
      "ollamaClassifyModel": { "type": "string", "description": "Defaults to llama3.2" },
      "symbols": {
        "type": "array",
        "items": { "type": "string" },
        "description": "e.g. [\"BTC\",\"ETH\"]"
      },
      "symbolAliasMap": {
        "type": "object",
        "description": "Ticker alias overrides e.g. { \"LUNA\": \"LUNC\" }"
      },
      "fearGreedIntervalCron": { "type": "string", "description": "Defaults to 0 */4 * * *" },
      "twitterIntervalCron": { "type": "string", "description": "Defaults to 0 */4 * * *" },
      "redditIntervalCron": { "type": "string", "description": "Defaults to 0 */4 * * *" },
      "newsIntervalCron": {
        "type": "string",
        "description": "Defaults to 0 */30 * * * (every 30 min)"
      },
      "macroDailyCron": { "type": "string", "description": "Defaults to 0 9 * * * (09:00 UTC)" },
      "macroWeeklyCron": {
        "type": "string",
        "description": "Defaults to 0 9 * * 1 (Monday 09:00)"
      },
      "compositeWeights": {
        "type": "object",
        "description": "Override default weights: { fearGreed: 0.3, twitter: 0.3, reddit: 0.3, funding: 0.1 }"
      },
      "regimeRules": {
        "type": "object",
        "description": "Override default regime classification thresholds"
      },
      "newsDefaultLimit": {
        "type": "number",
        "description": "Default limit for get_news_events (default: 10)"
      },
      "newsMaxLimit": {
        "type": "number",
        "description": "Max limit for get_news_events (default: 50)"
      },
      "alertChannelId": {
        "type": "string",
        "description": "OpenClaw channel ID for feed-stale alerts"
      }
    }
  }
}
```

---

## Data Flow

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                 BullMQ RepeatableJobs                   │
                    │  FearGreedFeed (4h) ─ TwitterFeed (4h) ─ RedditFeed (4h)│
                    │  CryptoPanicFeed (30min) ─ FredFeed (daily/weekly)       │
                    │  HealthMonitor (5min) ─ EmbeddingPipeline (consumer)     │
                    └────────────────────────┬────────────────────────────────┘
                                             │
                    ┌────────────────────────▼──────────────────────────────────┐
                    │           Feed poll worker (per feed)                      │
                    │   1. axios GET external API                                │
                    │   2. Zod validate response                                 │
                    │   3. Write sub-score to MemDir subfeed key (5h TTL)       │
                    │   4. Write health key: lastSuccessfulPoll                  │
                    └────────────────────────┬──────────────────────────────────┘
                                             │
                    ┌────────────────────────▼──────────────────────────────────┐
                    │              SentimentAggregator                           │
                    │   1. Read all sub-feed scores from MemDir                  │
                    │   2. Check freshness (TTL present = fresh)                 │
                    │   3. Redistribute weights for stale feeds                  │
                    │   4. Compute compositeScore (clamp to [0,1])              │
                    │   5. Derive fundingBias from {exchange}:funding:{symbol}  │
                    └────────────┬───────────────────────────────┬──────────────┘
                                 │                               │
          ┌──────────────────────▼──┐                 ┌─────────▼──────────────┐
          │    MemDir.set()         │                 │   TimescaleDB insert   │
          │  sentiment:composite:BTC│                 │  sentiment_snapshots   │
          │  (TTL: 4h)              │                 │  (hypertable)         │
          └─────────────────────── ┘                 └─────────┬──────────────┘
                                                               │
                                                  ┌────────────▼───────────────┐
                                                  │  BullMQ enqueue            │
                                                  │  sentiment:embed job       │
                                                  │  { type, id, timestamp }   │
                                                  └────────────┬───────────────┘
                                                               │
                                                  ┌────────────▼───────────────┐
                                                  │   EmbeddingPipeline        │
                                                  │  1. Read snapshot from DB  │
                                                  │  2. Serialize to text      │
                                                  │  3. POST Ollama embed      │
                                                  │  4. Upsert sentiment_      │
                                                  │     embeddings (pgvector)  │
                                                  └────────────────────────────┘

CryptoPanic / CoinGecko poll:
  axios GET → Zod validate → deduplicator → classifier (keyword + Ollama) → DB insert news_events

MacroScheduler daily/weekly:
  axios FRED/CMC + HTML scrape → Zod validate → upsert macro_snapshots → buildMacroContext()
    → MemDir.set(sentiment:macro:context, TTL: 24h) → enqueue macro embed job

Tool call:  get_sentiment("BTC")
  → MemDir.get("sentiment:composite:BTC")    ← single Redis GET, ≤100ms

Tool call:  get_macro_context()
  → MemDir.get("sentiment:macro:context")   ← single Redis GET, ≤200ms

Tool call:  get_news_events("BTC", 10)
  → pg.query SELECT FROM news_events WHERE symbols @> '{BTC}' ORDER BY publishedAt DESC LIMIT 10

Tool call:  get_feed_accuracy()
  → Redis HMGET sentiment:health:* + pg.query SELECT FROM feed_accuracy (30d window)
```

---

## Key Interfaces

### `IFeed<T>` (`src/feeds/types.ts`)

```typescript
export interface IFeed<T> {
  readonly feedId: string;
  readonly schedule: string; // cron expression
  poll(): Promise<T>; // resolves with validated feed data; throws on unrecoverable error
}
```

### `SentimentSnapshot` (`src/schema/SentimentSnapshot.ts`)

```typescript
export const SentimentSnapshotSchema = z.object({
  symbol: z.string(), // "BTC" | "global"
  fearGreedScore: z.number(), // [0, 1]
  fearGreedLabel: z.enum(["extreme_fear", "fear", "neutral", "greed", "extreme_greed"]),
  twitterScore: z.number(), // [0, 1]
  tweetVolume: z.number().int(),
  redditScore: z.number(), // [0, 1]
  redditPostVolume: z.number().int(),
  fundingBias: z.enum(["long", "short", "neutral"]),
  fundingRate: z.number(), // raw rate value
  compositeScore: z.number(), // [0, 1]
  lastUpdated: z.string(), // ISO timestamp
});
export type SentimentSnapshot = z.infer<typeof SentimentSnapshotSchema>;
```

### `MacroContext` (`src/schema/MacroSnapshot.ts`)

```typescript
export const MacroContextSchema = z.object({
  dxy: z.number(),
  us10y: z.number(),
  m2Supply: z.number(),
  oilPriceWti: z.number(),
  globalMarketCap: z.number(),
  btcDominance: z.number(),
  fomcNextDate: z.string().nullable(),
  fomcLastAction: z.enum(["hold", "cut", "hike"]).nullable(),
  cpiLastReading: z.number().nullable(),
  cpiNextDate: z.string().nullable(),
  regime: z.enum(["risk_on", "risk_off", "neutral", "uncertain"]),
  lastUpdated: z.string(),
});
export type MacroContext = z.infer<typeof MacroContextSchema>;
```

### `NewsEvent` (`src/schema/NewsEvent.ts`)

```typescript
export const NewsEventSchema = z.object({
  id: z.number().int(),
  headline: z.string(),
  source: z.string(),
  sentiment: z.enum(["positive", "negative", "neutral"]),
  impactClass: z.enum(["regulatory", "macro", "technical", "hack", "institutional"]),
  classificationConfidence: z.number(), // [0, 1]
  symbols: z.array(z.string()),
  publishedAt: z.string(),
  ingestedAt: z.string(),
});
export type NewsEvent = z.infer<typeof NewsEventSchema>;
```

### `FeedAccuracyReport` (`src/schema/FeedAccuracy.ts`)

```typescript
export const FeedAccuracyEntrySchema = z.object({
  feedId: z.string(),
  lastSuccessfulPoll: z.string().nullable(),
  isStale: z.boolean(),
  accuracy30d: z.number().nullable(), // null if sampleCount < 10
  sampleCount: z.number().int(),
  weight: z.number(), // [0.5, 1.5]; defaults to 1.0
});
export const FeedAccuracyReportSchema = z.object({
  feeds: z.array(FeedAccuracyEntrySchema),
  generatedAt: z.string(),
});
export type FeedAccuracyReport = z.infer<typeof FeedAccuracyReportSchema>;
```

---

## DB Schema

### `001_initial.sql` — full migration

```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- sentiment_snapshots hypertable
CREATE TABLE IF NOT EXISTS sentiment_snapshots (
  id              BIGSERIAL,
  symbol          TEXT        NOT NULL,
  fear_greed_score FLOAT8     NOT NULL,
  fear_greed_label TEXT       NOT NULL,
  twitter_score   FLOAT8,
  tweet_volume    INT,
  reddit_score    FLOAT8,
  reddit_post_volume INT,
  funding_bias    TEXT        NOT NULL,
  funding_rate    FLOAT8      NOT NULL,
  composite_score FLOAT8      NOT NULL,
  snapshotted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT create_hypertable('sentiment_snapshots', 'snapshotted_at', if_not_exists => TRUE);
SELECT add_retention_policy('sentiment_snapshots', INTERVAL '90 days', if_not_exists => TRUE);

-- news_events hypertable
CREATE TABLE IF NOT EXISTS news_events (
  id                       BIGSERIAL,
  headline                 TEXT        NOT NULL,
  source                   TEXT        NOT NULL,
  sentiment                TEXT        NOT NULL,
  impact_class             TEXT        NOT NULL,
  classification_confidence FLOAT8     NOT NULL,
  symbols                  TEXT[]      NOT NULL DEFAULT '{}',
  published_at             TIMESTAMPTZ NOT NULL,
  ingested_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT create_hypertable('news_events', 'ingested_at', if_not_exists => TRUE);
SELECT add_retention_policy('news_events', INTERVAL '90 days', if_not_exists => TRUE);

-- Deduplication index: normalized headline + 5-min bucket
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_events_dedup
  ON news_events (
    lower(regexp_replace(headline, '[^a-z0-9 ]', '', 'gi')),
    date_trunc('5 minutes', published_at)
  );

-- macro_snapshots (regular table, upsert by seriesId + effectiveDate)
CREATE TABLE IF NOT EXISTS macro_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  series_id      TEXT        NOT NULL,
  value          FLOAT8      NOT NULL,
  unit           TEXT        NOT NULL,
  effective_date DATE        NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_macro_series_date UNIQUE (series_id, effective_date)
);

-- feed_accuracy
CREATE TABLE IF NOT EXISTS feed_accuracy (
  id                  BIGSERIAL PRIMARY KEY,
  feed_id             TEXT        NOT NULL,
  trade_id            TEXT        NOT NULL,
  predicted_direction TEXT        NOT NULL CHECK (predicted_direction IN ('bullish','bearish','neutral')),
  outcome             TEXT        NOT NULL CHECK (outcome IN ('win','loss','breakeven')),
  score               SMALLINT    NOT NULL CHECK (score IN (0, 1)),
  scored_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feed_accuracy_feed_date
  ON feed_accuracy (feed_id, scored_at DESC);

-- sentiment_embeddings (pgvector)
CREATE TABLE IF NOT EXISTS sentiment_embeddings (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT        NOT NULL CHECK (type IN ('sentiment', 'macro')),
  timestamp   TIMESTAMPTZ NOT NULL,
  symbols     TEXT[]      NOT NULL DEFAULT '{}',
  regime      TEXT,
  text_chunk  TEXT        NOT NULL,
  embedding   vector(768) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_embedding UNIQUE (type, timestamp, symbols)
);
CREATE INDEX IF NOT EXISTS idx_sentiment_embeddings_hnsw
  ON sentiment_embeddings USING hnsw (embedding vector_cosine_ops);
```

---

## Dependencies

### New `dependencies` (runtime, `extensions/sentiment-intelligence/package.json`)

| Package  | Version  | Purpose                                                      |
| -------- | -------- | ------------------------------------------------------------ |
| `axios`  | `^1.7.x` | HTTP client for polling all external REST APIs               |
| `bullmq` | `^5.x`   | Redis-backed scheduled workers and embedding queue           |
| `zod`    | `^3.x`   | Schema validation at all external API and DB read boundaries |

### New `devDependencies`

| Package                 | Version | Purpose                               |
| ----------------------- | ------- | ------------------------------------- |
| `@testcontainers/redis` | `^10.x` | Redis container for integration tests |

### Reused from workspace (declare in `peerDependencies` or access via shared API)

| Package    | Source                                | Usage                                                                       |
| ---------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `ioredis`  | `@openclaw/trading-context` dep       | Redis client via `createMemDir` — no second connection created              |
| `pg`       | `@openclaw/market-data-ingestion` dep | pg Pool passed in via shared runtime API                                    |
| `openclaw` | workspace `*`                         | Plugin SDK (`openclaw/plugin-sdk/plugin-entry`, `openclaw/plugin-sdk/core`) |

**Note on `pg` pool**: The plugin accepts a `pg.Pool` instance injected via the `@openclaw/market-data-ingestion` public API surface (through `openclaw/plugin-sdk/market-data-ingestion` or a dedicated `api.ts` export). It does not create a second pool connection.

---

## Test Strategy

### Unit Tests (colocated `*.test.ts`)

| File                                      | What to test                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sentiment/aggregator.test.ts`        | Composite score calculation with all feeds healthy; weight redistribution when one/two feeds stale; clamping at [0, 1]; `compositeScore` matches manual calculation                 |
| `src/sentiment/regime-classifier.test.ts` | All regime branches: `risk_off`, `risk_on`, `neutral`, `uncertain` (missing series); configurable rule override                                                                     |
| `src/news/classifier.test.ts`             | Keyword-only classification for each `impactClass` and `sentiment`; Tier 2 Ollama path mocked; confidence threshold triggers Tier 2; low-confidence fallback to `neutral` + `macro` |
| `src/news/deduplicator.test.ts`           | Same normalized title + same 5-min bucket → dedup flag; different time buckets → not dedup; punctuation stripping; case normalization                                               |
| `src/schema/*.ts`                         | Zod parse valid shapes; Zod rejects missing required fields; enum validation for `sentiment`, `impactClass`, `regime`, `fundingBias`                                                |
| `src/embedding/serializer.test.ts`        | Text chunk contains expected fields; consistent format between runs for identical snapshot; no credentials in output                                                                |
| `src/health/AccuracyScorer.test.ts`       | Score 1 on outcome win + bullish signal; score 0 on outcome loss + bullish signal; `accuracy30d` null when sampleCount < 10; weight normalization formula                           |

### Feed Tests — Mock axios

Each feed test mocks `axios.get` to return fixture API responses (captured real API shapes). Tests verify:

1. Zod validation passes on valid response
2. Zod validation throws on malformed response (missing field)
3. Score normalization math
4. On `axios.get` rejecting (network error): feed throws so BullMQ retries; stale state set

| File                                | Feed                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/feeds/FearGreedFeed.test.ts`   | alternative.me response → normalized score                                                      |
| `src/feeds/TwitterFeed.test.ts`     | API v2 response → per-tweet sentiment → rolling average; bearer-token-absent → graceful disable |
| `src/feeds/RedditFeed.test.ts`      | `hot.json` response → keyword scoring → per-symbol filter → rolling average                     |
| `src/feeds/CryptoPanicFeed.test.ts` | headlines → classifier → dedup → DB insert shape                                                |
| `src/feeds/FredFeed.test.ts`        | FRED observations JSON → upsert shape; idempotent second call produces same row count           |

### Macro Tests

`src/macro/MacroScheduler.test.ts`:

- Mock axios for each FRED series; assert `macro_snapshots` upsert called with correct `(seriesId, effectiveDate)` shape
- Call scheduler twice with same data; assert `queries.upsertMacro` called twice but DB insert would produce same row count (idempotent)
- Assert `buildMacroContext()` calls `MemDir.set` with correct key and TTL

### Embedding Tests

`src/embedding/EmbeddingPipeline.test.ts`:

- Mock axios POST to Ollama; assert upsert called with 768-element array
- Ollama returns non-768-dim vector; assert Zod failure → retry
- Duplicate event for same `(type, timestamp, symbols)` → assert single upsert with `ON CONFLICT DO NOTHING`
- Ollama unreachable (axios throws); assert BullMQ retry invoked; `get_sentiment()` mock unaffected

### Health Monitor Tests

`src/health/HealthMonitor.test.ts`:

- Feed health key missing → `isStale: true`; alert sent
- Feed health key present and `lastSuccessfulPoll` within 2× interval → `isStale: false`
- Stale → recovered transition → `info` log emitted

### Integration Tests — Real Redis

Uses `@testcontainers/redis`. Validates:

- `SentimentAggregator` writes to MemDir, can be read back
- MemDir TTL is set correctly (Redis TTL command)
- Stale sub-feed (TTL expired) causes weight redistribution in composite

### Integration Tests — Real TimescaleDB (pgvector)

Uses `@testcontainers/postgresql` with `timescale/timescaledb-ha:pg16-latest` (includes pgvector). The `001_initial.sql` migration is applied at container start. Tests verify:

- Hypertable insert + select for `sentiment_snapshots`, `news_events`
- Macro upsert idempotency on `(seriesId, effectiveDate)` conflict
- Dedup index: inserting duplicate headline + time bucket → `ON CONFLICT DO NOTHING`
- Embedding upsert: 768-dim vector stored and retrievable

---

## Complexity Tracking

_No Constitution violations requiring justification._

---

## Open Questions / Risks

| #   | Question                                                                                        | Resolution approach                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Twitter API v2 recent-search endpoint availability (free tier removed for most users)           | Treat Nitter as the primary implementation path; configure Twitter API v2 as opt-in via `twitterBearerToken`. Nitter instances are volatile — document backup instance list in `quickstart.md`            |
| 2   | Reddit JSON API rate limits for unauthenticated requests                                        | Reddit allows ~60 reqs/min for unauthenticated JSON API. Use `User-Agent` header with app identifier. BullMQ schedule at 4 h intervals keeps total calls well below the limit                             |
| 3   | FOMC and CPI calendar scrape target stability (official Fed HTML may change format)             | Configure scrape target URL in plugin config. Document parsing assumptions. Weekly cron + health monitor alert if parse fails. Scrape target URL can be swapped to a structured calendar API if available |
| 4   | Ollama `nomic-embed-text` model pull: first-run setup required                                  | Document `ollama pull nomic-embed-text` in `quickstart.md`. Plugin startup check: if Ollama unreachable → log warn but continue. Embedding pipeline begins populating once Ollama is available            |
| 5   | `pnpm-workspace.yaml` — does `extensions/*` glob cover the new package?                         | Verify existing glob covers `extensions/sentiment-intelligence/` before wiring up; add explicit entry if needed                                                                                           |
| 6   | pgvector HNSW index build time on large `sentiment_embeddings` table during migration           | Index created only after table creation; if migration is applied to a table with existing rows, `CREATE INDEX CONCURRENTLY` should be used. Document this in migration notes                              |
| 7   | Shared `bullmq` queue naming collision with `002-market-data-ingestion`                         | Use prefix `sentiment:` for all queue names in this plugin (e.g. `sentiment:fear_greed`, `sentiment:embed`, `sentiment:health`). Prefix prevents collision with `trading:ratelimit:*` queues              |
| 8   | `get_news_events` DB query latency: `symbols @> '{BTC}'` scan on large `news_events` hypertable | Add GIN index on `symbols` column. TimescaleDB partition pruning limits scan to recent chunks. Document query plan in `quickstart.md`; if p99 exceeds 500 ms under load, add a materialized view          |
