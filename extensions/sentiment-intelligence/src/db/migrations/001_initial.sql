-- ============================================================================
-- 001_initial.sql — Sentiment Intelligence schema
-- All statements use IF NOT EXISTS guards for idempotent execution.
-- ============================================================================

-- Enable pgvector extension (TimescaleDB host must have it installed)
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------------------
-- 1. sentiment_snapshots — TimescaleDB hypertable, cold path for composite scores
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sentiment_snapshots (
  symbol                   TEXT        NOT NULL,
  timestamp                TIMESTAMPTZ NOT NULL,
  fear_greed_score         REAL,
  fear_greed_label         TEXT,
  twitter_score            REAL,
  tweet_volume             INTEGER,
  reddit_score             REAL,
  reddit_post_volume       INTEGER,
  funding_bias             TEXT,
  funding_rate             REAL,
  composite_score          REAL,
  regime                   TEXT
);

SELECT create_hypertable('sentiment_snapshots', 'timestamp', if_not_exists => TRUE);
SELECT add_retention_policy('sentiment_snapshots', INTERVAL '90 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_sentiment_snapshots_symbol_ts
  ON sentiment_snapshots (symbol, timestamp DESC);

-- ----------------------------------------------------------------------------
-- 2. news_events — TimescaleDB hypertable, 90-day retention
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS news_events (
  id                       BIGSERIAL,
  headline                 TEXT        NOT NULL,
  source                   TEXT        NOT NULL,
  url                      TEXT        NOT NULL,
  symbols                  TEXT[]      NOT NULL DEFAULT '{}',
  impact_class             TEXT,
  sentiment                TEXT        NOT NULL,
  relevance_score          REAL        NOT NULL,
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

-- ----------------------------------------------------------------------------
-- 3. macro_snapshots — narrow table, upsert by (series_id, effective_date)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS macro_snapshots (
  id             BIGSERIAL   PRIMARY KEY,
  series_id      TEXT        NOT NULL,
  value          FLOAT8      NOT NULL,
  unit           TEXT        NOT NULL DEFAULT '',
  effective_date DATE        NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_macro_series_date UNIQUE (series_id, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_macro_snapshots_series_date
  ON macro_snapshots (series_id, effective_date DESC);

-- ----------------------------------------------------------------------------
-- 4. sentiment_embeddings — pgvector table for RAG similarity search
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sentiment_embeddings (
  id          BIGSERIAL   PRIMARY KEY,
  type        TEXT        NOT NULL CHECK (type IN ('sentiment', 'macro')),
  symbol      TEXT        NOT NULL,
  timestamp   TIMESTAMPTZ NOT NULL,
  regime      TEXT,
  text_chunk  TEXT        NOT NULL,
  embedding   vector(768) NOT NULL,
  outcome     TEXT,
  pnl_pct     REAL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_embedding UNIQUE (type, timestamp, symbol)
);

CREATE INDEX IF NOT EXISTS idx_sentiment_embeddings_hnsw
  ON sentiment_embeddings USING hnsw (embedding vector_cosine_ops);

-- ----------------------------------------------------------------------------
-- 5. feed_accuracy — accuracy scoring per feed and evaluation period
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_accuracy (
  feed_name           TEXT        NOT NULL,
  correct_predictions INTEGER     NOT NULL DEFAULT 0,
  total_predictions   INTEGER     NOT NULL DEFAULT 0,
  accuracy_pct        REAL        NOT NULL DEFAULT 0,
  evaluated_at        TIMESTAMPTZ NOT NULL,
  period_days         INTEGER     NOT NULL,
  PRIMARY KEY (feed_name, evaluated_at, period_days)
);

CREATE INDEX IF NOT EXISTS idx_feed_accuracy_feed_scored
  ON feed_accuracy (feed_name, evaluated_at DESC);
