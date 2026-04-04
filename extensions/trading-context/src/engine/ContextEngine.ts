import { getEncoding } from "js-tiktoken";
import { HaltProtocol } from "../halt/HaltProtocol.js";
import type { MemDir } from "../memdir/MemDir.js";
import type { HistoryEntry } from "./History.js";
import type { StrategyOverride } from "./StrategyParser.js";
import { strategyToPromptClauses } from "./StrategyParser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextEngineOptions {
  memDir: MemDir;
  haltProtocol: HaltProtocol;
  /** Maximum token budget for the assembled context (default: 8000). */
  tokenBudget?: number;
  /** Truncation threshold as a fraction of tokenBudget (default: 0.9 = 90%). */
  truncationThreshold?: number;
  /** Trading symbol this engine is operating on. */
  symbol: string;
  /** Session ID for the current agent session. */
  sessionId: string;
}

/** Priority tiers for context sections — lower number = higher priority. */
const PRIORITY = {
  RISK: 1, // highest — MemDir risk flags, halt status
  STRATEGY: 2, // never truncated — strategy overrides
  QUANT: 3, // never truncated (Constitution II)
  HISTORY: 4, // truncated first
} as const;

export interface ContextSection {
  priority: (typeof PRIORITY)[keyof typeof PRIORITY];
  label: string;
  content: string;
  neverTruncate: boolean;
}

export interface AssembledContext {
  sections: ContextSection[];
  totalTokens: number;
  truncatedHistoryCount: number;
  systemPrompt: string;
}

// ---------------------------------------------------------------------------
// ContextEngine
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_BUDGET = 8_000;
const DEFAULT_TRUNCATION_THRESHOLD = 0.9;
const TRUNCATION_BANNER = (n: number) =>
  `<<CONTEXT_TRUNCATED: ${n} conversation entries removed to fit token budget>>`;

export class ContextEngine {
  private readonly memDir: MemDir;
  private readonly haltProtocol: HaltProtocol;
  private readonly tokenBudget: number;
  private readonly truncationThreshold: number;
  private readonly symbol: string;
  private readonly sessionId: string;
  private readonly enc = getEncoding("cl100k_base");

  constructor(opts: ContextEngineOptions) {
    this.memDir = opts.memDir;
    this.haltProtocol = opts.haltProtocol;
    this.tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.truncationThreshold = opts.truncationThreshold ?? DEFAULT_TRUNCATION_THRESHOLD;
    this.symbol = opts.symbol;
    this.sessionId = opts.sessionId;
  }

  private countTokens(text: string): number {
    return this.enc.encode(text).length;
  }

  /**
   * Assemble the complete LLM context for a tick.
   * Priority injection order:
   *   1. MemDir risk alerts (highest, never truncated)
   *   2. Strategy override clauses (high, never truncated)
   *   3. Quant feature vector (high, never truncated — Constitution II)
   *   4. Conversation history (lowest, truncated first)
   */
  async assemble(params: {
    strategy: StrategyOverride;
    history: HistoryEntry[];
    /** Optional quant signals from MemDir (populated by Phase 1 ingestion). */
    quantSnapshot?: Record<string, unknown>;
  }): Promise<AssembledContext> {
    const sections: ContextSection[] = [];

    // --- Section 1: Risk alerts from MemDir ---
    const riskLines: string[] = [];
    const haltFlag = await this.memDir.get({ key: "trading_halted", symbol: "*" });
    if (haltFlag?.value.halted) {
      riskLines.push(`⚠️ TRADING HALTED: ${haltFlag.value.reason}. Do NOT place orders.`);
    }
    const macroRegime = await this.memDir.get({ key: "macro_regime", symbol: this.symbol });
    if (macroRegime) {
      riskLines.push(`MACRO REGIME: ${macroRegime.value}`);
    }
    const fearGreed = await this.memDir.get({ key: "fear_greed", symbol: this.symbol });
    if (fearGreed) {
      riskLines.push(`FEAR & GREED: ${fearGreed.value.score} (${fearGreed.value.classification})`);
    }
    if (riskLines.length > 0) {
      sections.push({
        priority: PRIORITY.RISK,
        label: "## Risk & Market State",
        content: riskLines.join("\n"),
        neverTruncate: true,
      });
    }

    // --- Section 2: Strategy overrides ---
    const strategyClauses = strategyToPromptClauses(params.strategy);
    sections.push({
      priority: PRIORITY.STRATEGY,
      label: "## Strategy Directives",
      content: strategyClauses.join("\n"),
      neverTruncate: true,
    });

    // --- Section 3: Quant feature vector ---
    // Until Phase 1 (market data ingestion) is built, this reads from MemDir
    // keys populated by external feeds. If no quant keys exist, slot is omitted.
    const quantLines: string[] = [];
    if (params.quantSnapshot && Object.keys(params.quantSnapshot).length > 0) {
      for (const [key, val] of Object.entries(params.quantSnapshot)) {
        quantLines.push(`${key}: ${JSON.stringify(val)}`);
      }
    }
    const fundingRate = await this.memDir.get({ key: "funding_rate", symbol: this.symbol });
    if (fundingRate) {
      quantLines.push(
        `FUNDING_RATE: ${fundingRate.value.rate} (next: ${new Date(fundingRate.value.nextFundingAt).toISOString()})`,
      );
    }
    if (quantLines.length > 0) {
      sections.push({
        priority: PRIORITY.QUANT,
        label: "## Quantitative Features",
        content: quantLines.join("\n"),
        neverTruncate: true,
      });
    }

    // --- Section 4: Conversation history (lowest priority, truncated first) ---
    // We will handle truncation below
    const historySection: ContextSection = {
      priority: PRIORITY.HISTORY,
      label: "## Conversation History",
      content: params.history.map((h) => `[${h.role.toUpperCase()}] ${h.content}`).join("\n"),
      neverTruncate: false,
    };

    // --- Truncation logic ---
    const threshold = this.tokenBudget * this.truncationThreshold;
    const fixedContent = sections.map((s) => `${s.label}\n${s.content}`).join("\n\n");
    const fixedTokens = this.countTokens(fixedContent);

    let historyEntries = [...params.history];
    let truncatedCount = 0;
    let historyContent = historyEntries
      .map((h) => `[${h.role.toUpperCase()}] ${h.content}`)
      .join("\n");

    // Shed oldest entries until we fit within threshold
    while (
      historyEntries.length > 0 &&
      fixedTokens + this.countTokens(historyContent) > threshold
    ) {
      historyEntries = historyEntries.slice(1); // remove oldest
      truncatedCount++;
      historyContent = historyEntries
        .map((h) => `[${h.role.toUpperCase()}] ${h.content}`)
        .join("\n");
    }

    if (truncatedCount > 0) {
      historySection.content = TRUNCATION_BANNER(truncatedCount) + "\n" + historyContent;
    } else {
      historySection.content = historyContent;
    }

    if (historySection.content.trim()) {
      sections.push(historySection);
    }

    // Sort sections by priority before assembling
    sections.sort((a, b) => a.priority - b.priority);

    const systemPrompt = sections.map((s) => `${s.label}\n${s.content}`).join("\n\n");

    const totalTokens = this.countTokens(systemPrompt);

    return {
      sections,
      totalTokens,
      truncatedHistoryCount: truncatedCount,
      systemPrompt,
    };
  }
}

export function createContextEngine(opts: ContextEngineOptions): ContextEngine {
  return new ContextEngine(opts);
}
