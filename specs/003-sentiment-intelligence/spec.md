# Feature Specification: Sentiment Intelligence

**Feature Branch**: `003-sentiment-intelligence`
**Created**: 2026-04-05
**Status**: Draft
**Scope**: Phase 2 of the trading bot roadmap (see `docs/trading-bot-roadmap.md`). This spec covers the non-price signal ingestion layer: social sentiment feeds (Fear & Greed Index, Twitter/X, Reddit), crypto news ingestion with NLP classification, geoeconomic macro data (DXY, US10Y, FOMC, CPI, M2, Oil), sentiment and macro embeddings stored in pgvector for RAG retrieval, and a per-feed health monitor with accuracy scoring. It does NOT cover quantitative indicators or signal weighting (Phase 3), the main vector store or RAG retrieval loop (Phase 4), trade execution (Phase 5), or exchange market data (Phase 1). It depends on the pg pool connection and MemDir/Redis primitives from `002-market-data-ingestion`.
**Depends on**: `002-market-data-ingestion` (pg pool via `@openclaw/market-data-ingestion`, MemDir/Redis from `@openclaw/trading-context`)
**Package**: `extensions/sentiment-intelligence/` as `@openclaw/sentiment-intelligence`

---

## User Scenarios & Testing _(mandatory)_

### User Story 1 — Sentiment Snapshot Available to the Trading Agent via `get_sentiment()` (Priority: P1)

As a trading agent, I need to read a current sentiment snapshot for any configured symbol (and the overall crypto market) from shared memory without issuing external API calls myself, so my context window stays focused on strategy evaluation rather than data plumbing.

**Why this priority**: Sentiment is the primary non-price input for Phase 2. Until Fear & Greed, Twitter/X, and Reddit scores are continuously written into MemDir, no downstream strategy logic can incorporate social signal. All other sentiment-related stories depend on this feed being live and timely.

**Independent Test**: With the plugin running and at least one sentiment poll cycle completed (≤4 h after startup), call `get_sentiment("BTC")` via the OpenClaw tool interface. The returned object must include a `fearGreedScore` (0–1), a `twitterScore` (0–1), a `redditScore` (0–1), a `fundingBias` derived from the funding rate (sign + magnitude), and a composite `compositeScore` (0–1), all with a `lastUpdated` timestamp no older than 5 hours.

**Acceptance Scenarios**:

1. **Given** the Fear & Greed poll worker has completed its 4 h scheduled cycle, **When** `get_sentiment()` is called (no symbol arg — market-wide), **Then** the response includes `fearGreedScore`, `fearGreedLabel` (one of: `extreme_fear | fear | neutral | greed | extreme_greed`), and `lastUpdated` within the last 5 hours.
2. **Given** the Twitter/X 4 h rolling average worker has completed a cycle for `BTC`, **When** `get_sentiment("BTC")` is called, **Then** `twitterScore` is a float in [0, 1] (0 = bearish, 0.5 = neutral, 1 = bullish) and `tweetVolume` is a non-negative integer.
3. **Given** the Reddit 4 h rolling average worker has completed a cycle, **When** `get_sentiment("BTC")` is called, **Then** `redditScore` is a float in [0, 1] and reflects the combined r/CryptoCurrency + r/Bitcoin post sentiment for the symbol.
4. **Given** the funding rate for `BTC/USDT` has been ingested by `002-market-data-ingestion`, **When** `get_sentiment("BTC")` is called, **Then** `fundingBias` is `long` (positive rate), `short` (negative rate), or `neutral` (rate magnitude < 0.001%) with the raw rate value included.
5. **Given** `get_sentiment("BTC")` is called from within a tool invocation handler, **When** the tool resolves, **Then** the response is returned within 100 ms (reads from MemDir only — no DB or network calls on the hot path).

---

### User Story 2 — Macro Context Available via `get_macro_context()` (Priority: P1)

As a trading agent, I need to read the current geoeconomic macro context — DXY, US Treasury yields, FOMC calendar, CPI calendar, regime classification, and global crypto market cap — so I can factor macroeconomic conditions into trading decisions during risk-on/risk-off regime shifts.

**Why this priority**: Macro context is the second primary Phase 2 signal. DXY and yield data have historically driven crypto risk appetite. Without a reliable macro snapshot, the trading agent cannot distinguish a sentiment-driven dip from a macro-driven deleveraging event.

**Independent Test**: With the plugin running and at least one macro data pull completed, call `get_macro_context()`. The returned object must include `dxy` (float), `us10y` (float, percent), `fomcNextDate` (ISO date string), `fomcLastAction` (one of `hold | cut | hike`), `cpiLastReading` (float), `cpiNextDate` (ISO date string), `m2Supply` (float), `globalMarketCap` (float, USD), `btcDominance` (float, percent), `oilPriceWti` (float, USD), `regime` (one of `risk_on | risk_off | neutral | uncertain`), and `lastUpdated` (ISO timestamp).

**Acceptance Scenarios**:

1. **Given** the FRED API daily cron job has completed, **When** `get_macro_context()` is called, **Then** `dxy`, `us10y`, `m2Supply`, and `oilPriceWti` are non-zero floats with `lastUpdated` within the last 26 hours.
2. **Given** the FOMC calendar scrape has completed, **When** `get_macro_context()` is called, **Then** `fomcNextDate` is a future ISO date and `fomcLastAction` is one of `hold | cut | hike`.
3. **Given** the CpiCalendar scrape has completed, **When** `get_macro_context()` is called, **Then** `cpiLastReading` is a non-zero float and `cpiNextDate` is a future ISO date.
4. **Given** the CoinMarketCap daily cron job has completed, **When** `get_macro_context()` is called, **Then** `globalMarketCap` is a positive float (USD) and `btcDominance` is a float in (0, 100].
5. **Given** DXY > 104 and US10Y > 4.5 and `fomcLastAction` is `hike`, **When** `get_macro_context()` is called, **Then** `regime` is `risk_off`.
6. **Given** `get_macro_context()` is called from within a tool invocation handler, **When** the tool resolves, **Then** the response is returned within 200 ms (reads from MemDir cache — no DB or network calls on the hot path).

---

### User Story 3 — News Events Available via `get_news_events()` (Priority: P2)

As a trading agent, I need to query recent crypto news headlines classified by affected symbol and impact category, so I can reason about event-driven price moves (regulatory rulings, exchange hacks, institutional flows, macro releases) before placing or holding a trade.

**Why this priority**: News events represent high-impact, low-frequency signals. They are secondary to sentiment feeds because they fire episodically, but during market-moving events they overshadow rolling sentiment averages.

**Independent Test**: With the plugin running and at least one news ingestion cycle completed, call `get_news_events("BTC", 5)`. The returned array must contain up to 5 items, each with `headline` (string), `source` (string), `sentiment` (one of `positive | negative | neutral`), `impactClass` (one of `regulatory | macro | technical | hack | institutional`), `symbols` (string[]), and `publishedAt` (ISO timestamp).

**Acceptance Scenarios**:

1. **Given** the CryptoPanic ingestion worker has completed a cycle, **When** `get_news_events()` is called with no arguments, **Then** the response contains up to the default limit (10) of the most recent headlines from CryptoPanic sorted descending by `publishedAt`.
2. **Given** a headline mentioning "Bitcoin ETF approval" is ingested, **When** NLP classification runs, **Then** the headline is stored with `sentiment: "positive"` and `impactClass: "institutional"` and `symbols` includes `"BTC"`.
3. **Given** a headline about an exchange hack is ingested, **When** it is classified, **Then** `impactClass` is `"hack"` and `sentiment` is `"negative"`.
4. **Given** `get_news_events("ETH", 3)` is called, **When** the tool responds, **Then** only headlines where `symbols` includes `"ETH"` are returned and the count is at most 3.
5. **Given** both CryptoPanic and CoinGecko news sources are configured, **When** a duplicate headline appears in both feeds (same title, within 5-minute window), **Then** only one copy is stored in `news_events` (deduplication by normalized title + time bucket).

---

### User Story 4 — Sentiment Embeddings Created and Stored in pgvector for RAG Retrieval (Priority: P2)

As the RAG retrieval pipeline (Phase 4), I need each sentiment snapshot and macro context to be embedded as a 768-dimensional vector and stored in pgvector alongside market state vectors, so the agent can retrieve semantically similar historical sentiment contexts during inference without relying on exact-match queries.

**Why this priority**: Embedding creation is an async enrichment step — it does not block sentiment reads — but it must be established in Phase 2 so that Phase 4 (RAG loop) has meaningful historical signal vectors to query against.

**Independent Test**: After a sentiment poll cycle completes, query the `sentiment_embeddings` table directly. Each row must contain: `id`, `type` (`sentiment` or `macro`), `timestamp`, `symbols` (text array), `regime` (text), `text_chunk` (the serialized snapshot used for embedding), and `embedding` (a 768-dimensional `vector` column populated by `nomic-embed-text` via Ollama). The Euclidean distance between two embeddings from extreme-fear and extreme-greed market states must be meaningfully larger than the distance between two consecutive neutral-state embeddings.

**Acceptance Scenarios**:

1. **Given** a sentiment snapshot is written to MemDir, **When** the async embedding worker picks it up (within 60 s), **Then** a row is inserted into `sentiment_embeddings` with a 768-dim vector and metadata `{ type: "sentiment", timestamp, symbols[], regime }`.
2. **Given** a macro context snapshot is persisted to `macro_snapshots` in TimescaleDB, **When** the embedding worker runs, **Then** a row is inserted into `sentiment_embeddings` with `type: "macro"` and the serialized macro fields as `text_chunk`.
3. **Given** the embedding pipeline is backlogged (Ollama busy), **When** new sentiment snapshots continue to arrive, **Then** sentiment reads via `get_sentiment()` are unaffected — the hot path reads from MemDir, not from `sentiment_embeddings`.
4. **Given** an embedding has already been created for a sentiment snapshot at timestamp T, **When** the embedding worker processes a duplicate event for the same timestamp, **Then** no second row is inserted (idempotent upsert on composite key `type + timestamp + symbols`).
5. **Given** Ollama is unreachable, **When** the embedding worker attempts to embed, **Then** it retries with exponential backoff (base 5 s, cap 5 min) and logs a warning. Sentiment snapshots continue to be written to MemDir and TimescaleDB; only the `sentiment_embeddings` table is temporarily behind.

---

### User Story 5 — Feed Health Monitoring and Accuracy Scoring via `get_feed_accuracy()` (Priority: P3)

As a trading agent and operator, I need to know which sentiment feeds are healthy and how accurate each feed has been in predicting trade outcomes, so I can down-weight stale or poorly-performing signals and avoid basing decisions on data that has systematically mispredicted.

**Why this priority**: Health monitoring and accuracy scoring are operational quality layers on top of the core feeds. They improve signal reliability over time but are not required for the basic sentiment pipeline to function.

**Independent Test**: With at least two BullMQ sentiment poll cycles completed, call `get_feed_accuracy()`. The returned object must include per-feed entries for `fear_greed`, `twitter`, `reddit`, and `funding_bias`, each with: `feedId`, `lastSuccessfulPoll` (ISO timestamp), `isStale` (boolean), `accuracy30d` (float 0–1 or null if fewer than 10 scored trades), `sampleCount` (int), and `weight` (float, derived from accuracy).

**Acceptance Scenarios**:

1. **Given** a feed's BullMQ worker has not successfully completed a poll for longer than two consecutive scheduled intervals, **When** the health monitor cron fires (every 5 min), **Then** `isStale` is `true` in the feed health record, a `warn` log is emitted, and an alert is sent via the OpenClaw channel configured for the plugin.
2. **Given** a feed's BullMQ worker successfully polls, **When** the poll completes, **Then** `lastSuccessfulPoll` is updated and `isStale` resets to `false`.
3. **Given** a trade completes with a known outcome (profit/loss), **When** accuracy scoring runs, **Then** each active sentiment signal's predicted direction is compared against the trade outcome and a score (1 for correct, 0 for incorrect) is appended to the feed's 30-day rolling accuracy window in TimescaleDB.
4. **Given** a feed has fewer than 10 scored trades in the 30-day window, **When** `get_feed_accuracy()` is called, **Then** `accuracy30d` is `null` and `weight` defaults to `1.0` (equal weighting until sufficient data).
5. **Given** `get_feed_accuracy()` is called, **When** the tool responds, **Then** the per-feed `weight` values are consistent with their `accuracy30d` values: feeds with higher accuracy receive proportionally higher weight (linear normalization within [0.5, 1.5]).

---

### Edge Cases

- **Twitter/X API unavailable or rate-limited**: The Twitter worker catches API errors, logs a warning, increments the stale counter, and serves the last known `twitterScore` from MemDir. If two consecutive polls fail, the feed is marked stale and an operator alert is sent. The composite `compositeScore` is recalculated excluding the stale Twitter component (equal weight redistributed to remaining healthy feeds).
- **FRED API returns a series with no new data point** (e.g., M2 published weekly): The worker issues an idempotent upsert — if the existing row matches the fetched value, no write is performed and `lastUpdated` is not advanced. The MemDir entry retains the previous fetch timestamp.
- **Ollama embedding service unreachable at startup**: The plugin starts and operates normally. Sentiment reads, macro reads, and news reads all function. The embedding worker enters a retry loop and begins populating `sentiment_embeddings` once Ollama becomes available. A startup warning is logged.
- **News headline classification confidence is low** (NLP model returns probability < 0.6 for all classes): The headline is stored with `sentiment: "neutral"` and `impactClass: "macro"` as safe defaults, and a `classificationConfidence` field is stored with the actual value for downstream filtering.
- **Symbol mentioned in headline is ambiguous** (e.g., "LUNA" post-Terra collapse could refer to multiple tickers): The NLP classifier tags the most recently active symbol by that name. The operator can configure an explicit symbol alias map in plugin config to resolve ambiguities.
- **Duplicate Fear & Greed reading** (API polled, value has not changed since last poll): Stored as a new row in `sentiment_snapshots` with the current timestamp. The MemDir entry is refreshed (TTL reset). Downstream embeddings use the same text chunk; deduplication in `sentiment_embeddings` prevents a duplicate vector row.
- **Reddit JSON API rate limit**: Reddit's public JSON API may return 429 if polled too aggressively. The Reddit worker uses a conservative poll interval (4 h) and caps at 25 posts per subreddit per request. If the JSON API returns 429, the worker logs a warning, retains the last known score in MemDir, and retries at the next scheduled poll. If the full r/CryptoCurrency + r/Bitcoin scan cannot complete in one scheduling window, the partial result is stored and noted as `partial: true` in the MemDir entry.
- **TimescaleDB unavailable at startup**: The plugin starts and writes sentiment scores to MemDir only. TimescaleDB writes are queued in memory (up to 1,000 rows). Once TimescaleDB reconnects, queued rows are flushed. If the queue exceeds 1,000 entries, oldest rows are dropped (warn log). Embedding creation is paused until TimescaleDB is healthy (the embedding worker reads from `sentiment_snapshots`).
- **FOMC or CPI calendar scrape returns an unexpected page format**: The scraper logs a parse error, retains the last known values in MemDir, and sets `fomcNextDate` / `cpiNextDate` to `null` in the response (agent must treat null as "unknown"). An operator alert is sent.

---

## Requirements _(mandatory)_

### Functional Requirements

**Crypto Sentiment Feeds**

- **FR-001**: The plugin MUST poll the Fear & Greed Index from `alternative.me/crypto/fear-and-greed-index/` every 4 hours via a BullMQ scheduled worker and store the `score` (0–100) and `classification` label in TimescaleDB (`sentiment_snapshots`) and MemDir (key: `sentiment:subfeed:fear_greed`, TTL 14400 s).
- **FR-002**: The Fear & Greed score MUST be normalized to [0, 1] before being written to MemDir and exposed via `get_sentiment()` (formula: `normalizedScore = rawScore / 100`).
- **FR-003**: The plugin MUST compute a 4-hour rolling Twitter/X sentiment average per configured symbol using the Twitter/X Search API or a Nitter-compatible fallback. The average MUST include: `score` (0–1 bullish), `tweetVolume` (count of tweets in the window), and `lastUpdated`.
- **FR-004**: The plugin MUST compute a 4-hour rolling Reddit sentiment average by scanning posts from r/CryptoCurrency and r/Bitcoin via the Reddit JSON API (`/hot.json`, unauthenticated). Per-symbol score (0–1 bullish) and post volume MUST be stored in TimescaleDB and MemDir.
- **FR-005**: The plugin MUST derive a `fundingBias` signal for each symbol from the funding rate written by `002-market-data-ingestion` into MemDir. The bias MUST be classified as `long` (rate > 0.00001 in decimal, i.e. longs pay), `short` (rate < −0.00001), or `neutral` (magnitude ≤ 0.00001). No additional polling job is required for this signal.
- **FR-006**: The plugin MUST write a composite `SentimentSnapshot` per symbol to MemDir (key: `sentiment:composite:{symbol}` and `sentiment:composite:global` for market-wide). The composite MUST include `fearGreedScore`, `twitterScore`, `tweetVolume`, `redditScore`, `redditPostVolume`, `fundingBias`, `fundingRate`, `compositeScore`, and `lastUpdated`.
- **FR-007**: `compositeScore` MUST be computed as the weighted average of available healthy-feed scores. Default weights: Fear & Greed 30%, Twitter 30%, Reddit 30%, Funding Bias 10%. Weights MUST be redistributed proportionally when one or more feeds are stale. When ALL feeds are stale, `compositeScore` MUST default to 0.5 (neutral) and a `warn` log MUST be emitted.

**News & Event Feed**

- **FR-008**: The plugin MUST ingest headlines from at least one news source: CryptoPanic (REST API), via a BullMQ scheduled worker at a configurable interval (default: every 30 minutes). Additional sources (e.g., CoinGecko news REST API) MAY be added as optional feeds in future iterations.
- **FR-009**: Each ingested headline MUST be classified for sentiment (`positive | negative | neutral`) and impact class (`regulatory | macro | technical | hack | institutional`) using a two-tier approach: (1) keyword-based rule matching (synchronous, no I/O) with confidence 0.65–0.9; (2) local Ollama LLM inference (async, configurable model) only when Tier 1 confidence < 0.6. Classification results and `classificationConfidence` (float 0–1) MUST be stored.
- **FR-010**: Headlines MUST be stored in a TimescaleDB `news_events` table with columns: `id`, `headline`, `source`, `sentiment`, `impactClass`, `classificationConfidence`, `symbols` (text array), `publishedAt`, `ingestedAt`.
- **FR-011**: Duplicate headlines from different sources (same normalized title within a 5-minute time bucket) MUST be deduplicated on insert — only the first instance is stored.
- **FR-012**: The plugin MUST tag each headline with the affected crypto symbols by matching ticker names and aliases from a configurable symbol-alias map (default covers `BTC`, `ETH`, `BNB`, `SOL`, `XRP`).

**Geoeconomic Macro Layer**

- **FR-013**: The plugin MUST pull the following data series from the FRED API on a daily BullMQ cron schedule: DXY (US Dollar Index), US10Y (10-year Treasury yield), M2 (money supply), and WTI crude oil price (front-month contract or proxy series).
- **FR-014**: The plugin MUST pull the following from CoinMarketCap on a daily BullMQ cron schedule: global crypto market cap (USD) and BTC dominance (percent).
- **FR-015**: The plugin MUST scrape the FOMC meeting calendar (default target: `https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm`, configurable via `fomcCalendarUrl`) to determine: next meeting date and last action (`hold | cut | hike`). The scrape MUST run on a weekly BullMQ cron schedule. On HTML parse failure, the plugin MUST retain last known values in MemDir, set `fomcNextDate` to `null`, log a parse error, and send an operator alert.
- **FR-016**: The plugin MUST scrape the CPI release calendar (default target: `https://www.bls.gov/schedule/news_release/cpi.htm`, configurable via `cpiCalendarUrl`) to determine: last CPI reading and next scheduled release date. The scrape MUST run on a weekly BullMQ cron schedule. On HTML parse failure, the plugin MUST retain last known values in MemDir, set `cpiNextDate` to `null`, log a parse error, and send an operator alert.
- **FR-017**: All macro series MUST be stored as rows in a TimescaleDB `macro_snapshots` table with columns: `seriesId`, `value`, `unit`, `fetchedAt`, `effectiveDate`. All inserts MUST be idempotent upserts keyed on `(seriesId, effectiveDate)`.
- **FR-018**: A `MacroContext` object MUST be computed from the latest row per series and written to MemDir (key: `sentiment:macro:context`) after each successful macro pull. The `MacroContext` MUST include a `regime` classification (`risk_on | risk_off | neutral | uncertain`) derived from a configurable rule set (default rules documented in plugin README).
- **FR-019**: Default regime classification rules (operator-overridable via plugin config): `risk_off` if DXY > 104 AND US10Y > 4.5 AND `fomcLastAction == "hike"`; `risk_on` if DXY < 100 AND US10Y < 3.5; `neutral` when none of the `risk_off` or `risk_on` conditions are met AND all required series are present and fresh (effective date within 48 hours); `uncertain` if any required series is missing or older than 48 hours.

**Sentiment Embeddings**

- **FR-020**: After each sentiment snapshot is written to TimescaleDB, an async BullMQ worker MUST serialize the snapshot into a human-readable text chunk and submit it for embedding via `nomic-embed-text` through the Ollama HTTP API.
- **FR-021**: After each macro context snapshot is stored, the same async worker MUST serialize the macro fields into a text chunk and embed them.
- **FR-022**: Embedding results (768-dimensional float vectors) MUST be stored in a `sentiment_embeddings` table in TimescaleDB (with the pgvector extension) alongside: `type` (`sentiment | macro`), `timestamp`, `symbols` (text array), `regime`, and `text_chunk`.
- **FR-023**: Embedding inserts MUST be idempotent (upsert on composite key `type + timestamp + symbols`). The embedding worker MUST NOT block sentiment reads or macro reads on the hot path.
- **FR-024**: Each stored embedding MUST be tagged with metadata compatible with the Phase 4 RAG retrieval system: `{ type, timestamp, symbols[], regime }`.

**Feed Health Monitor & Accuracy Scoring**

- **FR-025**: A BullMQ cron worker MUST run every 5 minutes to check the staleness of each registered feed. A feed is stale if `now - lastSuccessfulPoll > 2 × scheduledInterval`.
- **FR-026**: When a feed becomes stale, the plugin MUST emit a `warn`-level log and send an alert via the configured OpenClaw channel. When the feed recovers, a `info`-level log MUST be emitted.
- **FR-027**: After a trade completes (event sourced from `002-market-data-ingestion` or a Phase 5 execution hook), the plugin MUST compare each feed's predicted direction at trade entry against the trade outcome and append an accuracy score (1 correct, 0 incorrect) to the feed's scoring history in TimescaleDB.
- **FR-028**: Accuracy scores MUST be stored in a `feed_accuracy` table with columns: `feedId`, `tradeId`, `predictedDirection` (`bullish | bearish | neutral`), `outcome` (`win | loss | breakeven`), `score` (0 or 1), `scoredAt`.
- **FR-029**: `get_feed_accuracy()` MUST compute per-feed `accuracy30d` (rolling 30-day mean of scores), `sampleCount`, `isStale`, `lastSuccessfulPoll`, and `weight` (linear normalization over [0.5, 1.5] based on `accuracy30d`; defaults to `1.0` if `sampleCount < 10`).

**OpenClaw Tool Registration**

- **FR-030**: The plugin MUST register the following OpenClaw tools via `openclaw/plugin-sdk/core`:
  - `get_sentiment(symbol?: string) → SentimentSnapshot` — returns the composite snapshot for the symbol (or market-wide if omitted); reads from MemDir only.
  - `get_macro_context() → MacroContext` — returns the current macro context; reads from MemDir only.
  - `get_news_events(symbol?: string, limit?: number) → NewsEvent[]` — returns the most recent classified headlines filtered by symbol (all symbols if omitted), sorted descending by `publishedAt`; default `limit` is 10, maximum is 50.
  - `get_feed_accuracy() → FeedAccuracyReport` — returns per-feed health and 30-day rolling accuracy.

### Non-Functional Requirements

- **NFR-001**: All feed polling MUST use BullMQ scheduled workers (not `setInterval` or ad-hoc timers). Workers MUST survive gateway restarts — job definitions are registered at plugin startup and re-registered idempotently.
- **NFR-002**: No API keys or credentials MUST be hard-coded. All credentials (Twitter Bearer token, FRED API key, CoinMarketCap API key, CryptoPanic API key) MUST be stored as `SecretRef` values in the plugin config and MUST NOT appear in logs, tool output, or error messages. The Reddit JSON API is unauthenticated and requires no credentials.
- **NFR-003**: When a feed misses 2 consecutive scheduled polls, the plugin MUST emit a `warn`-level log and send an alert via the configured OpenClaw channel. The alert payload MUST include: `feedId`, `lastSuccessfulPoll`, and `staleDurationMinutes`.
- **NFR-004**: All sentiment scores exposed via `get_sentiment()` and stored in MemDir MUST be in the normalized range [0, 1] (0 = maximally bearish, 0.5 = neutral, 1 = maximally bullish). Scores outside this range MUST be clamped before storage and a warning logged.
- **NFR-005**: Macro series inserts into `macro_snapshots` MUST be idempotent upserts keyed on `(seriesId, effectiveDate)`. A series MUST NOT be fetched from its source API more than once per calendar day per series (enforced via BullMQ job deduplication).
- **NFR-006**: The pgvector embedding pipeline MUST be fully async. Embedding creation latency MUST NOT block `get_sentiment()` or `get_macro_context()` reads. The Ollama embedding call runs in a background BullMQ worker, not in the poll worker's critical path.
- **NFR-007**: `get_sentiment()` MUST return within 100 ms. It MUST read exclusively from MemDir (a single Redis GET) and MUST NOT issue any database or external API calls.
- **NFR-008**: `get_macro_context()` MUST return within 200 ms. It MUST read exclusively from MemDir and MUST NOT issue any database or external API calls.
- **NFR-009**: The plugin MUST NOT degrade the OpenClaw host process event loop. All blocking I/O (HTTP calls, DB writes, Reddit scanning) MUST be async and contained within BullMQ worker callbacks.
- **NFR-010**: All plugin configuration values (poll intervals, feed weights, regime rules, symbol alias map, Ollama model name, news fetch limits) MUST be overridable via the plugin's `openclaw.plugin.json` config schema with sensible defaults.

---

## Out of Scope

The following are explicitly excluded from this phase:

- **Quantitative indicators** (RSI, MACD, Bollinger Bands, OB imbalance) — Phase 3.
- **Signal weighting and multi-factor scoring** beyond the fixed-weight composite defined in FR-007 — Phase 3.
- **RAG retrieval loop** using pgvector embeddings — Phase 4.
- **Semantic search over `sentiment_embeddings`** from agent context — Phase 4.
- **Trade execution** (order placement, position management) — Phase 5.
- **Strategy evaluation and backtesting** — Phase 5.
- **On-chain data** (wallet flows, exchange inflows/outflows, NFT activity) — not on roadmap.
- **Real-time social stream ingestion** (firehose Twitter streaming, live Reddit WebSocket) — this spec uses 4h rolling batchpolled averages only.
- **Multi-language news classification** — English-language headlines only.
- **A UI (web or mobile)** for monitoring feed health — operator observability is CLI and OpenClaw channel-based only.
- **Price prediction or directional signals** — this plugin provides raw sentiment context, not trading signals.

---

## Dependencies

### Internal (must be deployed and healthy before this plugin starts)

| Dependency                       | Provided by                                                 | Used for                                                                                                    |
| -------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| MemDir (Redis KV)                | `002-market-data-ingestion` / `001-advanced-context-memory` | Hot-path reads/writes for sentiment snapshots, macro context, feed health state                             |
| pg Pool (TimescaleDB connection) | `002-market-data-ingestion`                                 | Persisting `sentiment_snapshots`, `macro_snapshots`, `news_events`, `feed_accuracy`, `sentiment_embeddings` |
| FundingRate MemDir key           | `002-market-data-ingestion`                                 | Deriving `fundingBias` from `{exchange}:funding:{symbol}` without re-polling the exchange                   |
| Redis / BullMQ broker            | `002-market-data-ingestion` / `001-advanced-context-memory` | Scheduling all poll workers and the embedding worker; feed health cron                                      |
| OpenClaw plugin SDK              | `openclaw/plugin-sdk/core`                                  | Tool registration, plugin lifecycle hooks                                                                   |
| OpenClaw channel system          | Core                                                        | Operator alerts for stale feeds, TimescaleDB unavailability, embedding pipeline errors                      |

### External Services

| Service                             | Purpose                                                                 | Notes                                                     |
| ----------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| alternative.me Fear & Greed API     | Fear & Greed Index score + label                                        | Free, unauthenticated; poll every 4 h                     |
| Twitter/X Search API (or Nitter)    | 4 h rolling tweet sentiment per symbol                                  | Bearer token required; Nitter as unauthenticated fallback |
| Reddit JSON API                     | 4 h rolling post sentiment for r/CryptoCurrency + r/Bitcoin             | Unauthenticated; `GET /r/{sub}/hot.json`                  |
| CryptoPanic REST API                | Crypto news headlines + source metadata                                 | API key required                                          |
| CoinGecko News API                  | Additional crypto news headlines (optional future feed)                 | Free tier or API key; not implemented in initial scope    |
| FRED API (St. Louis Fed)            | DXY, US10Y, M2, WTI oil (daily series)                                  | FRED API key required                                     |
| CoinMarketCap API                   | Global market cap + BTC dominance (daily)                               | API key required                                          |
| FOMC / CPI calendar (scrape target) | Next meeting date, last action; last CPI reading, next release date     | HTML scrape; target URL configurable                      |
| Ollama (local inference)            | `nomic-embed-text` 768-dim embeddings for sentiment + macro text chunks | Must be running locally or on local network               |
| TimescaleDB (pgvector extension)    | Storing `sentiment_embeddings` vector rows                              | pgvector must be installed and extension enabled          |
| Redis                               | BullMQ job broker + MemDir backing store                                | Shared with plugins 001 and 002                           |

---

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: `get_sentiment("BTC")` returns a structurally valid `SentimentSnapshot` within 100 ms (including `fearGreedScore`, `twitterScore`, `redditScore`, `fundingBias`, `compositeScore`) after at least one full poll cycle has completed, measured over 100 consecutive calls.
- **SC-002**: `get_macro_context()` returns a structurally valid `MacroContext` within 200 ms (including `dxy`, `us10y`, `fomcNextDate`, `fomcLastAction`, `globalMarketCap`, `btcDominance`, `regime`) after the first daily macro pull completes, measured over 100 consecutive calls.
- **SC-003**: After 24 hours of continuous operation, `sentiment_snapshots` contains at least 6 Fear & Greed rows (one per 4 h poll), at least 6 Twitter/X rows per configured symbol, and at least 6 Reddit rows per configured symbol, with no gaps exceeding 5 hours.
- **SC-004**: `get_news_events("BTC", 10)` returns between 1 and 10 classified headlines, each with a non-null `sentiment`, `impactClass`, `classificationConfidence`, and `publishedAt`, within 500 ms of the call.
- **SC-005**: After 48 hours of operation, `sentiment_embeddings` contains at least one row per sentiment snapshot and one row per macro snapshot stored during that window, all with non-null 768-dim `embedding` vectors.
- **SC-006**: When a configured feed misses 2 consecutive scheduled polls, an alert is delivered via the configured OpenClaw channel within 10 minutes. When the feed recovers, the stale state clears automatically.
- **SC-007**: `get_feed_accuracy()` returns a `FeedAccuracyReport` with entries for all registered feeds (at minimum: `fear_greed`, `twitter`, `reddit`, `funding_bias`), each with a valid `isStale` boolean and `lastSuccessfulPoll` timestamp.
- **SC-008**: No credentials (Twitter Bearer token, FRED key, CoinMarketCap key, CryptoPanic key, Ollama endpoint details) appear in log output, tool responses, or error messages at any log level.
- **SC-009**: Running the plugin through one complete daily cycle does not increase the OpenClaw host process heap by more than 50 MB compared to baseline (no memory leak from accumulating BullMQ jobs or MemDir entries).
- **SC-010**: All macro series upserts are idempotent: re-running the daily FRED and CoinMarketCap cron jobs manually a second time on the same calendar day produces the same `macro_snapshots` row counts (no duplicates).

---

## Architecture / Design Decisions

- **BullMQ for all scheduling**: Sentiment poll workers (Fear & Greed, Twitter, Reddit), news ingestion workers, macro pull workers (FRED, CoinMarketCap, FOMC, CPI), the embedding worker, and the feed health monitor are all BullMQ `RepeatableJob` instances registered at plugin startup. This ensures all scheduled work survives gateway restarts and is observable via BullMQ's Redis-backed state.
- **MemDir as the hot-path read layer**: `get_sentiment()` and `get_macro_context()` read exclusively from Redis via MemDir. TimescaleDB is the persistence layer for historical querying and the embedding source — it is not on the hot path for tool calls.
- **Compositing in the write path**: `compositeScore` is computed once per poll cycle when the snapshot is written to MemDir, not at read time. This keeps `get_sentiment()` to a single Redis GET.
- **Async embedding pipeline**: The embedding worker is a BullMQ consumer on a dedicated queue (`sentiment:embed`). Sentiment snapshot workers push a job to this queue after writing to TimescaleDB. The embedding worker calls Ollama, then upserts into `sentiment_embeddings`. Zero coupling between the poll critical path and Ollama availability.
- **Funding bias derived, not polled**: `fundingBias` reads from the MemDir key written by `002-market-data-ingestion` (`{exchange}:funding:{symbol}`). This avoids a redundant exchange API poll and ensures funding sentiment stays in sync with the ingestion layer.
- **Regime classification as a configurable rule set**: The default rules (FR-019) are simple threshold checks on DXY, US10Y, and FOMC action. They are intentionally simple so that Phase 3 can replace or augment the regime signal with a model-based classifier without changing the data contract.
- **Symbol alias map in config**: Tweet and Reddit post classification uses a configurable alias map (e.g., `{ "LUNA": "LUNC" }`) to handle tickers that have changed. The map defaults cover common cases; operators extend it for niche symbols.
- **Deduplication boundary for news**: Headlines are deduplicated by normalized title (lowercase, stripped punctuation) + 5-minute time bucket. This prevents cross-source duplicates while allowing genuinely distinct stories that share similar titles published at very different times to both be ingested.
- **pgvector extension sharing with Phase 4**: The `sentiment_embeddings` table is created in this plugin but is designed to be queried by the Phase 4 RAG pipeline without schema changes. The metadata columns (`type`, `timestamp`, `symbols`, `regime`) are sized for Phase 4 filter predicates from day one.
- **SecretRef for all credentials**: Every external API credential is declared in the plugin manifest as a `SecretRef`. The plugin reads credentials at startup and MUST fail fast with a descriptive error if any required credential is missing (rather than silently running with degraded feeds).

---

## Assumptions

- `002-market-data-ingestion` is deployed and healthy before this plugin starts. The pg pool connection and MemDir Redis client are available via the shared runtime API (`@openclaw/market-data-ingestion`).
- TimescaleDB has the pgvector extension installed (`CREATE EXTENSION IF NOT EXISTS vector`). Schema migrations for `sentiment_snapshots`, `macro_snapshots`, `news_events`, `feed_accuracy`, and `sentiment_embeddings` are applied automatically by the plugin at first startup.
- Ollama is running locally (or on the local network) with the `nomic-embed-text` model pulled. The Ollama base URL is configurable via plugin config (default: `http://localhost:11434`).
- The operator supplies all required API credentials as `SecretRef` values before plugin startup. The plugin performs a startup check and logs a clear error for each missing credential.
- Twitter/X sentiment uses the Search API (v2 recent search endpoint). If the project tier does not have access to the Search API, a Nitter-compatible fallback base URL is configurable, bearing in mind that Nitter instances may be rate-limited or unstable.
- Reddit sentiment uses the public JSON API (`/r/{subreddit}/hot.json`), which requires no authentication. The 4 h poll interval and limit of 25 posts per request keeps request volume well within Reddit's public API rate limits.
- News NLP classification uses a lightweight local Ollama model (e.g., `llama3.2`). The model name is configurable. Operators may substitute any Ollama-compatible model that supports a classification prompt.
- FOMC and CPI calendar scraping targets official or widely-cached public sources. The scrape target URLs are configurable so operators can substitute a structured data API if one becomes available.
- The configured trading symbols match the symbols ingested by `002-market-data-ingestion`. The plugin does not auto-discover symbols; the operator sets `sentiment.symbols[]` in plugin config (default: `["BTC", "ETH"]`).
- Feed accuracy scoring requires trade outcome events from the execution layer (Phase 5). Until Phase 5 is deployed, `accuracy30d` will be `null` for all feeds and weights default to `1.0`.
- The system runs as a single Node.js/Bun process (no horizontal worker scaling). BullMQ concurrency settings are tuned for single-process operation.
