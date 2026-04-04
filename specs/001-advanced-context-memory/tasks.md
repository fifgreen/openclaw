# Tasks: Advanced Context & Memory

**Revised**: 2026-04-04

## Phase 1: Setup

- [x] T001 Initialize bundled plugin `extensions/trading-context/` with `package.json`, `openclaw.plugin.json`, and `src/` subdirectories (`memdir/`, `engine/`, `halt/`, `hooks/`). Set up strict export boundaries in `src/api.ts`. Add `ioredis`, `zod`, and `js-tiktoken` to `dependencies`. Create journal directory setup utility (`ensureJournalDir`) that initializes `{stateDir}/training/trades/` on first write.

## Phase 2: MemDir Foundation

**Goal**: Typed, namespaced, TTL-aware Key-Value store with bounded timeouts.
**Tests**: Typed keys, TTL expiry, timeout behavior, namespace isolation.

- [x] T002 Establish Redis client connection utilities inside `extensions/trading-context/src/memdir/index.ts` (using `ioredis`, connection config from OpenClaw config)
- [x] T003 [US1] Define `MemDirTypedKeys` registry in `memdir/keys.ts` — Zod schemas per key pattern, TTL defaults, namespace validation. Initial keys: `trading_halted`, `macro_regime`, `fear_greed`, `funding_rate`, `sentiment`, `dxy`, `us10y`, `consecutive_timeouts`, `last_tick_at`
- [x] T004 [US1] Build `MemDir.ts` — typed Redis wrapper implementing:
  - `get<K>(key: K): Promise<MemDirValue<T> | null>` with bounded timeout (default 5s, configurable)
  - `set<K>(key: K, value: T, opts?: { ttlMs?: number }): Promise<void>` with auto `updatedAt` + `source`
  - TTL freshness check on read: expired values return `null`
  - Namespaced key construction: `{scope}:{symbol}:{key}`
  - Timeout returns `null` (same as missing), caller handles skip-tick logic
- [x] T005 [P] [US1] Write colocated tests in `extensions/trading-context/src/memdir/MemDir.test.ts`:
  - Typed key read/write roundtrip
  - TTL expiry (write a value, advance time, verify it returns null)
  - Bounded timeout behavior (mock slow Redis, verify null return after 5s)
  - Namespace isolation (BTC key does not collide with ETH key)
  - Concurrent write from two sources (latest write wins, `updatedAt` reflects winner)

## Phase 3: Halt Protocol (P1 — safety-critical, build before execution logic)

**Goal**: Deterministic failure response that secures positions and notifies operator.
**Tests**: Full sequence verification, recovery flow, idempotency.

- [x] T005b Define `ExchangeAdapter` interface in `extensions/trading-context/src/halt/types.ts` — typed contract for `cancelOrders(symbol: string): Promise<CancelResult>` and `closePositions(symbol: string): Promise<CloseResult>`. Provide a `MockExchangeAdapter` for testing. Real implementations (Binance, Bybit) will be wired in Phase 5 of the roadmap.
- [x] T006 [US4] Implement `halt/HaltProtocol.ts` — accepts an `ExchangeAdapter` (from T005b). Ordered halt sequence:
  1. Cancel open orders via `ExchangeAdapter.cancelOrders()`
  2. Close positions at market via `ExchangeAdapter.closePositions()`
  3. Set `global:*:trading_halted` in MemDir with reason + timestamp
  4. Send notification via OpenClaw channel system (import from `src/routing/` or hook into existing notification path)
  5. Log full halt context to DecisionJournaler
  6. Stop tick loop for affected agent(s)
- [x] T007 [US4] Implement `halt/recovery.ts` — `/trading resume` handler:
  1. Re-validate active strategy JSON via Zod
  2. Test MemDir connectivity
  3. Clear `trading_halted` flag
  4. Resume tick loop
  5. Send confirmation notification
- [x] T008 [P] [US4] Write colocated tests in `extensions/trading-context/src/halt/HaltProtocol.test.ts`:
  - Halt fires all 6 steps in order on invalid strategy
  - Halt fires after N consecutive MemDir timeouts
  - `trading_halted` flag is idempotent (double-halt does not double-notify within cooldown)
  - Recovery validates strategy before clearing flag
  - Recovery fails if strategy is still invalid (stays halted)

## Phase 4: Token-Aware Context Aggregation

**Goal**: Prevent `context_length_exceeded` errors during volatile periods.
**Tests**: Truncation threshold, priority preservation, budget enforcement.

- [x] T009 [US2] Create `ContextEngine.ts` core — aggregates:
  - MemDir state snapshot (macro, sentiment, risk flags) → **highest priority, never truncated**
  - Strategy override clauses → **high priority, never truncated**
  - Quant feature vector summary → **high priority, never truncated** (Constitution II: quant features MUST be present before qualitative reasoning). _Note: Until Phase 1 (market data ingestion) is built, this slot reads from MemDir keys populated by external feeds. If no quant keys exist in MemDir, the slot is omitted from the prompt (not an error)._
  - Conversation history → lowest priority, truncated first
  - Token counting via `js-tiktoken` (cl100k_base encoding for OpenAI-compatible models; extend with provider-specific encodings as needed)
- [x] T010 [US2] Implement truncation logic: at 90% token threshold, shed oldest conversation history entries. Insert `<<CONTEXT_TRUNCATED: {n} entries removed>>` banner so the agent knows.
- [x] T011 [P] [US2] Write colocated tests in `extensions/trading-context/src/engine/ContextEngine.test.ts`:
  - Risk alerts survive truncation even at 100% budget
  - Oversized history gets truncated to fit
  - Truncation banner is present when history is shed
  - Strategy overrides are preserved verbatim
  - Quant feature vector survives truncation even at capacity (Constitution II)

## Phase 5: Strategy-Specific Prompt Overrides

**Goal**: Dynamic strategy JSON gates the agent's reasoning.
**Tests**: Invalid JSON triggers halt, valid JSON produces correct prompt clauses.

- [x] T012 [US3] Implement `StrategyParser.ts` — Zod schema for `StrategyOverride`. Maps structured fields (`bias`, `maxDrawdown`, `allowedAssets`, `entryConditions`, `exitRules`, `confluenceThreshold`) to system-prompt clause strings.
- [x] T013 [US3] Wire `StrategyParser` output into `ContextEngine.ts` prompt assembly. On Zod parse failure → delegate to `HaltProtocol`.
- [x] T014 [P] [US3] Write tests:
  - Valid strategy produces expected prompt clauses (long-only bias, ATR-based TP, etc.)
  - Invalid strategy JSON triggers halt protocol (not silent failure)
  - Different strategies produce demonstrably different prompts

## Phase 6: Decision Journaling & History

**Goal**: Persist full decision context for review and future fine-tuning (Phase 7 of roadmap).
**Tests**: Journal output format, context capture completeness.

- [x] T015 [US5] Create `History.ts` — per-session conversation ledger tracking inference iterations, tool calls, and state variables.
- [x] T015b [US5] Expose history query tools (`get_session_history`, `get_last_decision`) via the plugin tool contract, reading from the `History` ledger. Register in `src/api.ts`. (FR-004)
- [x] T016 [US5] Implement `Journaler.ts` — intercepts final prompt assembly + agent decision, writes JSONL entries including:
  - Complete MemDir state snapshot at decision time
  - Applied `StrategyOverride`
  - Quant signals active during tick
  - Final agent reasoning and action
  - For halts: full halt context (trigger, positions closed, orders canceled)
- [x] T017 [P] [US5] Write colocated tests in `extensions/trading-context/src/engine/Journaler.test.ts`:
  - Journal entry captures all required fields
  - Halt events are journaled with full context
  - JSONL format is valid (parseable line by line)

## Phase 7: OpenClaw Integration

**Goal**: Wire the trading-context plugin into OpenClaw's existing infrastructure.
**Tests**: Integration works with agent sessions, hooks, and channels.

- [x] T018 Implement `hooks/risk-gate.ts` — a `before-tool-call` hook that:
  - Checks `trading_halted` flag in MemDir before any order placement tool executes
  - Validates that MemDir state is fresh (not past TTL) before trade tools
  - Blocks order tools if risk conditions are violated
- [x] T019 Register trading tools (`get_market_snapshot`, `get_quant_features`, `place_order`, etc.) via OpenClaw plugin tool contract in `api.ts`
- [x] T020 Wire halt notifications and `/trading resume` commands through OpenClaw's channel routing (`src/routing/`)
- [x] T021 [P] Integration test: simulate a full tick cycle — MemDir read → context assembly → strategy validation → (mock) LLM call → decision journal write
- [x] T022 [P] Integration test: simulate halt trigger → verify notification sent via channel mock → simulate `/trading resume` → verify recovery

---

**Implementation Strategy:**

MVP order: **T001–T005** (MemDir with typed keys and bounded timeout) → **T005b–T008** (ExchangeAdapter interface + Halt protocol — safety-critical, must exist before any execution logic) → **T009–T011** (Context engine) → **T012–T014** (Strategy parser) → **T015–T015b, T016–T017** (Journaling + history tools) → **T018–T022** (OpenClaw integration wiring).

The halt protocol (Phase 3) is intentionally built before token-aware context (Phase 4) because the context engine needs to delegate failures to the halt system. Building halt first means every subsequent component has a defined failure path from day one.
