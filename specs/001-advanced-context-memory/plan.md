# Implementation Plan: Advanced Context & Memory

**Branch**: `001-advanced-context-memory` | **Date**: 2026-04-03 | **Revised**: 2026-04-04 | **Spec**: [spec.md](./spec.md)

## Summary

This feature establishes the prerequisite foundation for the trading bot roadmap (`docs/trading-bot-roadmap.md`). It builds two core primitives:

1. **MemDir** — a typed, namespaced, TTL-aware Key-Value cache backed by Redis for multi-agent state sharing (macro regime, sentiment, risk flags). Uses bounded timeouts (not infinite blocking) to avoid Node.js event-loop deadlocks.
2. **ContextEngine** — a token-aware prompt assembler that merges strategy overrides, MemDir state, and conversation history into a budget-constrained LLM context, with automatic truncation and priority-based injection.

Both integrate with OpenClaw's existing infrastructure: agent sessions (`src/agents/`), before-tool-call hooks, channel routing (for halt notifications), and the plugin SDK.

## Technical Context

**Language/Version**: TypeScript / Node.js 22+  
**Primary Dependencies**: `ioredis` (Redis client), `zod` (schema validation), `js-tiktoken` (pure JS token counting — no native/WASM binding, works in Node 22+)  
**Storage**: Redis (for `MemDir` Key-Value atomicity)  
**Testing**: `vitest`  
**Target Platform**: OpenClaw CLI/Local Server  
**Project Type**: Backend Architecture Module (OpenClaw plugin)  
**Performance Goals**: Sub-5ms Redis `MemDir` resolution  
**Constraints**: MemDir reads use bounded timeout (default 5s) — NOT infinite blocking. After N consecutive timeouts, halt protocol fires.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

- **Principle V. Shared Multi-Agent Context**: _Pass_ — Core objective; decoupling macro injection from generic inference via MemDir.
- **Principle III. Fail-Safe Risk Management**: _Pass_ — Bounded timeout + skip-tick + halt escalation prevents both blind trades AND event-loop deadlocks. Halt protocol secures positions and notifies operator.
- **Principle II. Quantitative Rigor**: _Pass_ — The `ContextEngine` merges structured quantitative limits directly into the inference sequence via Zod-parsed strategy overrides.

## Project Structure

### Documentation (this feature)

```text
specs/001-advanced-context-memory/
├── plan.md              # This file
├── research.md          # Captured explicit decisions
├── data-model.md        # Entity definitions (MemDir, ContextEngine, HaltProtocol, etc.)
├── tasks.md             # Implementation task breakdown
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code

```text
extensions/
└── trading-context/                    # [NEW] Bundled workspace plugin
    ├── package.json                    # Plugin package with own deps (ioredis, etc.)
    ├── openclaw.plugin.json            # Plugin manifest
    └── src/
        ├── memdir/
        │   ├── MemDir.ts               # Typed Redis KV with timeout, TTL, namespacing
        │   ├── MemDir.test.ts          # Tests: typed keys, TTL expiry, timeout behavior
        │   ├── keys.ts                 # MemDirTypedKeys registry (Zod schemas per key)
        │   └── index.ts
        ├── engine/
        │   ├── ContextEngine.ts        # Token counting, truncation, priority injection
        │   ├── ContextEngine.test.ts   # Tests: truncation, priority, strategy merge
        │   ├── StrategyParser.ts       # Zod validation for strategy JSON → prompt overrides
        │   ├── History.ts              # Per-session conversation tracking ledger
        │   ├── Journaler.ts            # Decision journal writer (JSONL)
        │   ├── Journaler.test.ts       # Tests: output format, context capture
        │   └── index.ts
        ├── halt/
        │   ├── types.ts                # ExchangeAdapter interface
        │   ├── HaltProtocol.ts         # Ordered halt sequence (cancel → close → flag → notify)
        │   ├── HaltProtocol.test.ts    # Tests: full sequence, recovery, idempotency
        │   ├── recovery.ts             # /trading resume handler
        │   └── index.ts
        ├── hooks/
        │   └── risk-gate.ts            # before-tool-call hook for pre-trade risk validation
        └── api.ts                      # Strict boundary exports (public surface)
```

**Tests**: Colocated per repo convention — `*.test.ts` alongside their source files.

**Structure Decision**: A bundled workspace plugin in `extensions/trading-context/` follows repo convention (AGENTS.md: bundled plugins belong in the workspace plugin tree). Plugin-only deps (`ioredis`, `js-tiktoken`) stay in the extension `package.json`. Strict entrypoint via `api.ts`. The `halt/` subdirectory isolates the safety-critical halt protocol from the data plumbing.

## Integration with OpenClaw

This plugin does NOT create parallel infrastructure — it builds on what exists:

| OpenClaw Component                                   | Integration Point                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Agent sessions (`src/agents/`)                       | Trading agents run as OpenClaw agent sessions. MemDir state is read at tick start within the session lifecycle.                 |
| Hook system (`src/agents/hooks.before-tool-call.ts`) | Risk gates inject via before-tool-call hooks. Strategy validation runs before any order placement tool executes.                |
| Channel routing (`src/channels/`, `src/routing/`)    | Halt notifications → operator's configured channel. `/trading resume` commands are received and routed through the same system. |
| Plugin SDK (`src/plugin-sdk/`)                       | Trading tools register via the standard plugin tool contract (`toolFactory()`).                                                 |
| Provider system                                      | LLM selection (Qwen for ticks, Claude for strategy) uses OpenClaw's provider config — no custom provider wiring.                |
