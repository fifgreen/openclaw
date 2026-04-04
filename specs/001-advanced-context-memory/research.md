# Research: Advanced Context Memory

All structural unknowns were resolved interactively via the Speckit Clarify phase. Revised 2026-04-04 to fix critical issues identified during review.

### Decision 1: MemDir Backend

- **Decision**: Typed, namespaced Key-Value store backed by Redis with atomic GET/SET semantics. Each value carries `updatedAt` (Unix ms) and optional `ttlMs` for freshness checking. Keys are namespaced by symbol (`btc:macro_regime`, `eth:fear_greed`) and scope (`global:trading_halted`).
- **Rationale**: Real-time trading requires predictable sub-5ms lookups. Untyped `string → any` would be a maintenance landmine given the roadmap's `QuantFeatureVector` (30+ fields). Timestamps + TTL let agents detect feed failures (e.g., Fear & Greed API died 2 hours ago) without separate health checks. Namespacing prevents key collisions when running multiple pairs.
- **Alternatives considered**:
  - Append-only Event Stream: too much overhead parsing back to current state.
  - File System blocking: slow I/O, no atomicity under concurrent writes.
  - Untyped `string → any`: original proposal, rejected because it provides no freshness guarantees and makes refactoring risky.

### Decision 2: Strategy Validation Failure

- **Decision**: Deterministic halt protocol — cancel open orders → close positions at market → set `trading_halted` in MemDir → notify operator via OpenClaw channel (Telegram/Discord) → log to decision journal → require explicit `/trading resume` to restart.
- **Rationale**: An autonomous quant system cannot default to a generalized "safe" state. But a silent halt is equally dangerous — open positions remain exposed, and the operator may not discover the failure for hours. The halt protocol secures capital AND ensures visibility. Every halt is operator-visible by design.
- **Alternatives considered**:
  - Silent halt (original proposal): rejected because it leaves positions exposed without notification.
  - Graceful degradation to fallback strategy: rejected because partial execution under invalid constraints risks capital loss.

### Decision 3: MemDir Read Timeouts

- **Decision**: Bounded timeout (default 5 seconds). On timeout, skip the current tick, log a warning, and increment a consecutive-failure counter. After N consecutive timeouts (default 3), trigger the halt protocol.
- **Rationale**: Node.js is single-threaded. An indefinite block on a Redis GET deadlocks every agent on the same process — the ETH agent freezes because the BTC agent is waiting on a stale key. Bounded timeout + skip-tick achieves the same safety guarantee (no blind trades) without destroying the event loop. The consecutive-failure threshold escalates to halt protocol, matching the original intent of "never trade without data."
- **Alternatives considered**:
  - Infinite blocking (original proposal): rejected because it deadlocks the Node.js event loop. All agents on the process freeze, not just the one with the missing key.
  - Micro-timeouts (<100ms) with tick-drop: too aggressive; transient Redis latency spikes would drop too many ticks unnecessarily.

### Decision 4: Integration with OpenClaw (NEW)

- **Decision**: Build as an OpenClaw plugin (`src/plugins/trading-context/`) that integrates with existing infrastructure rather than creating parallel systems.
- **Rationale**: OpenClaw already provides agent session lifecycle (`src/agents/`), before-tool-call hooks (natural injection point for risk gates), multi-channel routing (for halt notifications and `/trading resume`), and a plugin SDK for tool registration. Building on these avoids duplication and ensures the trading system benefits from upstream improvements.
- **Alternatives considered**:
  - Standalone system alongside OpenClaw: rejected because it duplicates session management, notification routing, and tool infrastructure.

### Decision 5: Value Freshness & Feed Health (NEW)

- **Decision**: Every MemDir value includes `updatedAt` timestamp and optional `ttlMs`. Readers check `now - updatedAt > ttlMs` — expired values are treated as missing (same as timeout path).
- **Rationale**: Without freshness checking, an agent could silently act on 3-hour-old macro data because the producing feed crashed. TTL-based expiry converts feed failures into explicit missing-data events, which flow through the established timeout → skip-tick → halt escalation path.
- **Alternatives considered**:
  - Separate health monitor polling each feed: adds complexity; TTL-on-read is simpler and catches the same failure mode.
