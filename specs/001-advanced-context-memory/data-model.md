# Data Model: Advanced Context & Memory

**Revised**: 2026-04-04

## Entities

### `ContextEngine`

- **Fields**:
  - `activeSessionId` (string)
  - `tokenBudget` (number) — max tokens for assembled prompt
  - `contextStrategy` (StrategyOverride)
  - `truncationThreshold` (number) — percentage (default 0.9) at which truncation kicks in
- **Relationships**: Owns an `AgentSession` lifecycle. Reads from `MemDir`. Delegates failure to `HaltProtocol`.
- **State/Behavior**: Enforces max constraints defined in `StrategyOverride`. On Zod parse failure, triggers `HaltProtocol`.

### `MemDir (SharedState)`

- **Type**: Typed, namespaced Redis Key-Value store
- **Key Schema**: `{scope}:{symbol}:{key}` where:
  - `scope` = `global` | `agent` | `feed`
  - `symbol` = `btc` | `eth` | `*` (for global keys)
  - `key` = the actual field name
  - Examples: `global:*:trading_halted`, `feed:btc:macro_regime`, `feed:btc:fear_greed`, `agent:btc:consecutive_timeouts`
- **Value Schema** (`MemDirValue<T>`):
  - `value` (T) — the actual data, typed per key
  - `updatedAt` (number) — Unix ms timestamp of last write
  - `ttlMs` (number | null) — optional TTL; if `now - updatedAt > ttlMs`, value is treated as missing
  - `source` (string) — identifier of the writing agent/feed (e.g., `"ingestion:binance"`, `"risk-coordinator"`)
- **Rules**:
  - Atomic read/writes via Redis GET/SET
  - Reads use bounded timeout (default 5s), NOT infinite blocking
  - Stale values (past TTL) are treated as missing
  - All values are JSON-serialized with Zod validation on read

### `MemDirTypedKeys` (key registry)

- **Purpose**: Closed set of known keys with their value types, preventing typo-driven bugs and enforcing schema
- **Known keys** (initial set, extensible):

| Key Pattern                           | Value Type                                                 | TTL Default | Description                         |
| ------------------------------------- | ---------------------------------------------------------- | ----------- | ----------------------------------- |
| `global:*:trading_halted`             | `{ halted: boolean, reason: string, haltedAt: number }`    | none        | Global halt flag                    |
| `feed:{symbol}:macro_regime`          | `"risk-on" \| "risk-off" \| "neutral"`                     | 4h          | Current macro regime                |
| `feed:{symbol}:fear_greed`            | `{ score: number, classification: string }`                | 4h          | Fear & Greed index                  |
| `feed:{symbol}:funding_rate`          | `{ rate: number, nextFundingAt: number }`                  | 8h          | Current funding rate                |
| `feed:{symbol}:sentiment`             | `{ twitter: number, reddit: number, tweetVolume: number }` | 4h          | Social sentiment scores             |
| `feed:*:dxy`                          | `{ value: number, changePct: number }`                     | 24h         | Dollar index                        |
| `feed:*:us10y`                        | `{ value: number, changeBps: number }`                     | 24h         | US 10Y yield                        |
| `agent:{symbol}:consecutive_timeouts` | `number`                                                   | none        | Timeout counter for halt escalation |
| `agent:{symbol}:last_tick_at`         | `number`                                                   | none        | Unix ms of last successful tick     |

### `StrategyOverride`

- **Fields**:
  - `id` (string) — strategy identifier (e.g., `"btc-trend-follower-v4"`)
  - `bias` (`"long-only" | "short-only" | "both"`)
  - `maxDrawdown` (number) — as percentage (e.g., 0.03 = 3%)
  - `allowedAssets` (string[]) — e.g., `["BTC/USDT", "ETH/USDT"]`
  - `entryConditions` (object) — strategy-specific constraints injected into prompt
  - `exitRules` (object) — TP/SL/trailing rules
  - `confluenceThreshold` (number) — minimum signal alignment score (e.g., 3 out of 5)
- **Rules**: Zod parsing required. Failure to parse triggers `HaltProtocol`, not silent fallback.

### `RiskSignal`

- **Fields**:
  - `severity` (enum: `WARN` | `HALT`)
  - `code` (string) — machine-readable reason (e.g., `"max_drawdown_exceeded"`, `"consecutive_timeouts"`, `"invalid_strategy"`)
  - `message` (string) — human-readable description
  - `timestamp` (Date)
  - `symbol` (string | null) — affected symbol or null for global
- **Rules**: `HALT` severity triggers the full halt protocol. `WARN` signals are injected into prompt context at highest priority but do not stop trading.

### `HaltProtocol`

- **Trigger conditions**: Invalid strategy JSON, N consecutive MemDir timeouts, max drawdown exceeded, manual `/trading stop`
- **Sequence** (all steps are mandatory and ordered):
  1. Cancel all open orders for affected symbol(s) via exchange API
  2. Close open positions at market price
  3. Set `global:*:trading_halted` in MemDir with reason and timestamp
  4. Send notification to operator via OpenClaw channel system (Telegram/Discord/Slack)
  5. Log full context (trigger reason, positions closed, orders canceled) to DecisionJournaler
  6. Stop tick loop for affected agent(s)
- **Recovery**: Requires `/trading resume` command via any OpenClaw channel. On resume:
  1. Re-validate active strategy JSON via Zod
  2. Verify MemDir connectivity (test read)
  3. Clear `trading_halted` flag
  4. Resume tick loop
  5. Send confirmation notification

### `AgentSessionHistory`

- **Fields**: array of inference iterations and tool variables
- **Relationships**: Bound uniquely to `AgentSession`.

### `DecisionJournaler`

- **Fields**: `logDestinationPath` (string) — typically `{stateDir}/training/trades/{YYYY-MM}.jsonl`
- **Rules**: Logs MUST include: final agent reasoning, the applied `StrategyOverride`, exact quant signals active during the tick, MemDir state snapshot, and (for halts) the full halt context.
