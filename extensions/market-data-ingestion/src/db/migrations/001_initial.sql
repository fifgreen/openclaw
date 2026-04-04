-- Migration 001: Initial TimescaleDB hypertables, continuous aggregates, retention and compression policies
-- Run once against a TimescaleDB-enabled PostgreSQL instance.

-- ───────────────────────────────────────────────
-- Raw tick data hypertable
-- ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_ticks (
  timestamp       TIMESTAMPTZ    NOT NULL,
  exchange        TEXT           NOT NULL,
  symbol          TEXT           NOT NULL,
  price           DOUBLE PRECISION NOT NULL,
  quantity        DOUBLE PRECISION NOT NULL,
  side            TEXT           NOT NULL CHECK (side IN ('buy', 'sell')),
  trade_id        TEXT           NOT NULL,
  local_timestamp TIMESTAMPTZ    NOT NULL,
  PRIMARY KEY (timestamp, exchange, symbol, trade_id)
);

SELECT create_hypertable(
  'price_ticks', 'timestamp',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- ───────────────────────────────────────────────
-- Order book snapshots hypertable
-- ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ob_snapshots (
  timestamp    TIMESTAMPTZ    NOT NULL,
  exchange     TEXT           NOT NULL,
  symbol       TEXT           NOT NULL,
  depth        INT            NOT NULL,
  sequence_id  BIGINT         NOT NULL,
  bids         JSONB          NOT NULL,
  asks         JSONB          NOT NULL,
  PRIMARY KEY (timestamp, exchange, symbol, sequence_id)
);

SELECT create_hypertable(
  'ob_snapshots', 'timestamp',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- ───────────────────────────────────────────────
-- Funding rates hypertable
-- ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS funding_rates (
  timestamp         TIMESTAMPTZ    NOT NULL,
  exchange          TEXT           NOT NULL,
  symbol            TEXT           NOT NULL,
  rate              DOUBLE PRECISION NOT NULL,
  next_funding_time TIMESTAMPTZ    NOT NULL,
  PRIMARY KEY (timestamp, exchange, symbol)
);

SELECT create_hypertable(
  'funding_rates', 'timestamp',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- ───────────────────────────────────────────────
-- Continuous aggregate views — OHLCV candles
-- Computed from price_ticks without requiring a separate klines feed.
-- ───────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS ohlcv_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', timestamp) AS timestamp,
  symbol,
  first(price, timestamp)            AS open,
  max(price)                         AS high,
  min(price)                         AS low,
  last(price, timestamp)             AS close,
  sum(quantity)                      AS volume
FROM price_ticks
GROUP BY time_bucket('1 minute', timestamp), symbol
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS ohlcv_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('5 minutes', timestamp) AS timestamp,
  symbol,
  first(price, timestamp)             AS open,
  max(price)                          AS high,
  min(price)                          AS low,
  last(price, timestamp)              AS close,
  sum(quantity)                       AS volume
FROM price_ticks
GROUP BY time_bucket('5 minutes', timestamp), symbol
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS ohlcv_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', timestamp) AS timestamp,
  symbol,
  first(price, timestamp)          AS open,
  max(price)                       AS high,
  min(price)                       AS low,
  last(price, timestamp)           AS close,
  sum(quantity)                    AS volume
FROM price_ticks
GROUP BY time_bucket('1 hour', timestamp), symbol
WITH NO DATA;

-- ───────────────────────────────────────────────
-- Refresh policies for continuous aggregates
-- ───────────────────────────────────────────────
SELECT add_continuous_aggregate_policy('ohlcv_1m',
  start_offset => INTERVAL '2 hours',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE
);

SELECT add_continuous_aggregate_policy('ohlcv_5m',
  start_offset => INTERVAL '6 hours',
  end_offset   => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);

SELECT add_continuous_aggregate_policy('ohlcv_1h',
  start_offset => INTERVAL '2 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- ───────────────────────────────────────────────
-- Retention policies (raw data)
-- ───────────────────────────────────────────────
-- Raw price ticks: keep 7 days
SELECT add_retention_policy(
  'price_ticks',
  INTERVAL '7 days',
  if_not_exists => TRUE
);

-- OB snapshots: keep 7 days (generally less important than ticks)
SELECT add_retention_policy(
  'ob_snapshots',
  INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Funding rates: keep 90 days (lower volume, useful for historical analysis)
SELECT add_retention_policy(
  'funding_rates',
  INTERVAL '90 days',
  if_not_exists => TRUE
);

-- 1m OHLCV aggregate: keep 90 days
SELECT add_retention_policy(
  'ohlcv_1m',
  INTERVAL '90 days',
  if_not_exists => TRUE
);

-- 1h OHLCV aggregate: retain indefinitely (no retention policy)

-- ───────────────────────────────────────────────
-- Compression policies (reduce storage for older chunks)
-- ───────────────────────────────────────────────
ALTER TABLE price_ticks SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'exchange, symbol',
  timescaledb.compress_orderby   = 'timestamp DESC'
);

SELECT add_compression_policy(
  'price_ticks',
  INTERVAL '2 days',
  if_not_exists => TRUE
);
