# Feature Specification: Advanced Agent Context & Memory Architecture

**Feature Branch**: `001-advanced-context-memory`  
**Created**: 2026-04-03  
**Revised**: 2026-04-04  
**Status**: Draft  
**Scope**: Prerequisite foundation for the trading bot roadmap (see `docs/trading-bot-roadmap.md`). This spec covers Phase 0 — shared agent state, context assembly, and strategy enforcement. It does NOT cover market data ingestion (Phase 1), quant math (Phase 3), pgvector embeddings (Phase 4), or trade execution (Phase 5). Those phases depend on the primitives built here.  
**Input**: User description: "start a new feature... greatly improve the way openclaw is handling context, memory, sharing between agents, prompting and more if needed from marcel/ folder..."

## Clarifications

### Session 2026-04-03

- Q: What is the core data exchange pattern and backing infrastructure for the Shared Memory Directory (`MemDir`)? → A: Pure Key-Value cache (e.g., Redis GET/SET) with atomic overrides for immediate state reads.
- Q: How should the ContextEngine handle corrupted or contradictory JSON strategy overrides? → A: Enter the **halt protocol**: (1) cancel all open orders for the affected symbol, (2) close open positions at market, (3) set `trading_halted` flag in MemDir so other agents are aware, (4) send notification via OpenClaw channels (Telegram/Discord), (5) log full error context to the decision journal, (6) require explicit `/trading resume` command to restart. The agent MUST NOT silently halt — every halt is operator-visible.
- Q: What is the acceptable timeout threshold when a Trading Agent attempts to read state from the `MemDir`? → A: Bounded timeout (default 5s). On timeout the agent MUST skip the current tick, log a warning, and notify the operator. After N consecutive timeouts (default 3), the agent enters halt protocol. Rationale: Node.js is single-threaded — an indefinite block deadlocks all agents on the same process. Bounded timeout + skip-tick achieves the same safety (no blind trades) without destroying the event loop.
- Q: What happens when a MemDir value is stale (written long ago but never updated)? → A: Every MemDir value carries a `updatedAt` timestamp and an optional `ttlMs`. The reader checks freshness: if `now - updatedAt > ttlMs`, the value is treated as missing (same as timeout path). Agents never act on stale data.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Multi-Agent State Synchronization (Priority: P1)

As a quantitative trading agent, I need to read the latest extracted market sentiment and macro events produced by the specific ingestion agent asynchronously, without having to generate it myself, so I can save my context window for evaluating complex strategies.

**Why this priority**: Efficient separation of concerns saves token budgets and inference latency, heavily maximizing throughput and eliminating rate limit exhaustion.

**Independent Test**: Can be fully tested by simulating an Ingestion agent writing to the `memdir` and the Strategy agent correctly pulling the active subset of that memory during the next tick.

**Acceptance Scenarios**:

1. **Given** the Ingestion subsystem has recently fetched "risk-on" macro state, **When** the trading agent ticks and builds its prompt context, **Then** it injects the "risk-on" state via the shared memory directory without direct API polling.
2. **Given** two concurrent agent sessions (e.g. BTC and ETH traders), **When** a global risk coordinator issues a "drawdown_halt" flag to `memdir`, **Then** both agent sessions read this flag at the start of their next tick and suspend trading.

---

### User Story 2 - Token-Aware Context Aggregation (Priority: P2)

As a trading system, I want to intelligently track and truncate historical data injected into the LLM context (indicators, tick history, order flow) based on a hard token budget, so that the agent always triggers successfully without unhandled `context_length_exceeded` errors.

**Why this priority**: Market states can bloat context rapidly, especially during volatile periods with massive order flow diffs. LLMs must reliably execute every tick.

**Independent Test**: Provide an intentionally oversized vector of historical data and verify the `ContextAggregator` truncates the least relevant older items to fit the specified token limits.

**Acceptance Scenarios**:

1. **Given** an aggressive strategy requiring deep tick context, **When** the token threshold reaches 90% capacity, **Then** the context engine seamlessly truncates the oldest 20% of order book snapshots before prompting the LLM.

---

### User Story 3 - Strategy-Specific Prompt Overrides (Priority: P3)

As a strategy creator, I want the active JSON trading strategy to dynamically override sections of the LLM system prompt, so that the agent strictly adheres to my quant boundaries rather than utilizing its generic problem-solving logic.

**Why this priority**: Strategies must forcefully gate inference. Generic bots will bleed capital if left strictly to generalized reasoning.

**Independent Test**: Compare the assembled prompt for a standard "swing" strategy vs a "scalping" strategy. The final LLM input must demonstrably include differing constraints and strict entry validations.

**Acceptance Scenarios**:

1. **Given** an agent running a "btc-trend-follower" strategy, **When** the prompt is generated, **Then** it explicitly includes the required directional bias (e.g. "long-only") and ATR-based take-profit logic extracted from the strategy JSON.

---

### User Story 4 - Halt Protocol & Recovery (Priority: P1)

As a trading system operator, I need all agent failures (invalid strategy, MemDir timeout, risk breach) to follow a deterministic halt protocol that secures positions, notifies me, and requires explicit recovery — so I never discover a silent failure hours later with exposed positions.

**Why this priority**: A 24/7 autonomous system with no defined failure mode is more dangerous than one that doesn't trade at all.

**Independent Test**: Inject an invalid strategy JSON mid-session and verify the full halt sequence fires: orders canceled, positions closed, MemDir flag set, channel notification sent, recovery blocked until `/trading resume`.

**Acceptance Scenarios**:

1. **Given** the ContextEngine receives an unparseable strategy JSON, **When** Zod validation fails, **Then** the halt protocol fires: open orders are canceled, positions are closed at market, `trading_halted` is set in MemDir, and a notification is sent via the operator's configured OpenClaw channel.
2. **Given** a trading agent experiences 3 consecutive MemDir read timeouts, **When** the timeout counter reaches the threshold, **Then** the halt protocol fires (same sequence as above) and the agent does NOT attempt further ticks.
3. **Given** the system is in halted state, **When** the operator sends `/trading resume` via any OpenClaw channel, **Then** the halt flag is cleared, the strategy is re-validated, and tick processing resumes only if validation passes.

---

### User Story 5 - Decision Journaling (Priority: P2)

As a trading system operator, I need every agent inference — including HOLD decisions and halt events — to be journaled with full context (MemDir snapshot, active strategy, quant signals, reasoning), so I can audit past decisions, build fine-tuning datasets, and debug anomalies after the fact.

**Why this priority**: Constitution Principle IV mandates transparent journaling. Without it, post-hoc analysis and RAG/fine-tuning pipelines are impossible.

**Independent Test**: Run a simulated tick cycle and verify the JSONL journal entry contains all required fields. Run a simulated halt and verify the halt context is captured.

**Acceptance Scenarios**:

1. **Given** an agent completes a tick (trade or HOLD), **When** the decision is finalized, **Then** a JSONL entry is written containing: MemDir state snapshot, applied StrategyOverride, active quant signals, final reasoning, and action taken.
2. **Given** the halt protocol fires, **When** the halt sequence completes, **Then** a JSONL entry is written containing: trigger reason, positions closed, orders canceled, and full MemDir state at halt time.

### Edge Cases

- What happens when the underlying `memdir` (memory directory) experiences a write conflict from two ingestion agents? → Atomicity is guaranteed via Redis GET/SET overrides; the latest write wins. Each value carries an `updatedAt` timestamp so readers can detect ordering.
- How does the system handle an agent attempting to read a deeply truncated context? → Provide an explicit `<<CONTEXT_TRUNCATED>>` system banner so the agent is aware it lacks full history.
- What if the Strategy JSON is invalid or corrupted? → The `ContextEngine` triggers the **halt protocol** (see User Story 4) — not a silent crash.
- What if a MemDir value exists but is stale (the producing feed died)? → Every value has a `ttlMs`. Expired values are treated as missing, triggering the timeout/skip-tick path.
- What if Redis itself is down? → MemDir read fails immediately (connection error), treated as timeout. After N consecutive failures, halt protocol fires.
- What if two agents both try to set `trading_halted` simultaneously? → The flag is idempotent (SET if not already set). The halt notification deduplicates via a cooldown window (default 60s).

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST support a shared "memory directory" component for asynchronous multi-agent flag and variable sharing, backed by Redis with atomic GET/SET semantics.
- **FR-002**: System MUST orchestrate agent contexts via a central `ContextEngine` that measures approximate token usage prior to inference.
- **FR-003**: The `ContextEngine` MUST accept dynamic strategy JSONs and translate them into strict system-prompt clauses ("Overrides") at runtime.
- **FR-004**: System MUST store full conversational history objects per Session, including inference iterations, tool call results, and MemDir state at each tick. History entries MUST be queryable by the agent via tool calls (e.g., `get_session_history`, `get_last_decision`).
- **FR-005**: Risk alerts and macro signals MUST be injected at the HIGHEST priority in the prompt generation loop, overriding historical data limits.
- **FR-006**: MemDir reads MUST use a bounded timeout (default 5s). On timeout, the agent MUST skip the tick and log a warning. After N consecutive timeouts (default 3), the agent MUST enter the halt protocol. Agents MUST NOT execute ticks without confirmed fresh global risk state.
- **FR-007**: Every MemDir value MUST carry an `updatedAt` timestamp and an optional `ttlMs`. Values older than their TTL MUST be treated as missing.
- **FR-008**: MemDir keys MUST be namespaced by symbol (e.g., `btc:macro_regime`, `eth:fear_greed`) and by scope (`global:trading_halted`).
- **FR-009**: All agent failures (invalid strategy, MemDir timeout threshold, risk breach) MUST trigger the halt protocol: cancel open orders, close positions at market, set `trading_halted` in MemDir, notify operator via OpenClaw channel, log to decision journal.
- **FR-010**: Recovery from halt MUST require explicit operator action (`/trading resume`) via any OpenClaw channel. The system MUST re-validate the active strategy before resuming.
- **FR-011**: The trading-context plugin MUST integrate with OpenClaw's existing agent session lifecycle (`src/agents/`), hook system (`hooks.before-tool-call`), and channel system for notifications.
- **FR-012**: Every agent inference (including HOLD decisions) and every halt event MUST be written to a JSONL decision journal capturing: MemDir state snapshot, applied StrategyOverride, active quant signals, agent reasoning, and action taken. (Constitution Principle IV)

### Key Entities

- **`ContextEngine`**: Aggregates LLM system prompts, strategy configurations, and user history into a final API-ready structure. Calculates tokens, manages truncation limits, and merges strategy overrides.
- **`MemDir (SharedState)`**: A typed, namespaced Key-Value cache backed by Redis with atomic GET/SET semantics. Each value carries `updatedAt` and optional `ttlMs` for freshness checking. Keys are namespaced by symbol (`btc:`, `eth:`) and scope (`global:`).
- **`AgentSession`**: The lifecycle wrapper for a specific pairing (e.g., BTC/USDT), possessing an internal `History` ledger of past decisions and holds.
- **`HaltProtocol`**: The deterministic failure-response sequence: cancel orders → close positions → set MemDir flag → notify operator → await recovery.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Context assembly error rate (`max_tokens` exceeded) plummets to <0.01% of all evaluated ticks.
- **SC-002**: Prompting latency and total token usage drops by >15% per tick due to efficient sharing of macro indicators instead of duplicated retrieval.
- **SC-003**: The Trading Agent demonstrably fails validation gates generated dynamically by the Strategy Prompt >99% of the time they violate the configuration (verified by unit tests).

## Assumptions

- Redis is available locally or via network for `MemDir` backend. Filesystem fallback is NOT supported — Redis atomicity is required.
- Ingestion tasks (news, macro, exchange) run in parallel and publish state to MemDir with `updatedAt` timestamps.
- Models utilized (Qwen 3.5 via Ollama for high-frequency ticks, Claude API for high-stakes reasoning) handle system prompt overrides and multi-turn instruction.
- OpenClaw's agent session lifecycle (`src/agents/`), hook system, and channel routing are stable and available for integration.
- Exchange APIs (Binance, Bybit) are reachable for the halt protocol's order cancellation and position closing.

## Integration Points with OpenClaw

This feature builds on existing OpenClaw infrastructure rather than replacing it:

- **Agent Sessions** (`src/agents/`): MemDir-powered trading agents run as OpenClaw agent sessions. The `AgentSession` wrapper delegates lifecycle to OpenClaw's session management.
- **Hook System** (`src/agents/hooks.before-tool-call.ts`): Risk gates and strategy validation inject via before-tool-call hooks. This is the natural extension point for pre-trade checks.
- **Channel System** (`src/channels/`, `src/routing/`): Halt notifications, trade alerts, and `/trading resume` commands flow through OpenClaw's existing multi-channel routing.
- **Plugin SDK** (`src/plugin-sdk/`): Trading tools (order placement, market queries, strategy management) register via the standard plugin tool contract.
- **Provider System**: LLM provider selection (Qwen vs Claude) uses OpenClaw's provider plugin config — no custom provider wiring needed.
