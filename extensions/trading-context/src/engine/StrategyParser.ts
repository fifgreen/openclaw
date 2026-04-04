import { z } from "zod";

// ---------------------------------------------------------------------------
// StrategyOverride schema — Zod validation for trading strategy JSON.
// ---------------------------------------------------------------------------

export const StrategyOverrideSchema = z.object({
  id: z.string(),
  bias: z.enum(["long-only", "short-only", "both"]),
  maxDrawdown: z.number().min(0).max(1), // e.g. 0.03 = 3%
  allowedAssets: z.array(z.string()).min(1),
  entryConditions: z.record(z.string(), z.unknown()),
  exitRules: z.record(z.string(), z.unknown()),
  confluenceThreshold: z.number().int().min(1),
});

export type StrategyOverride = z.infer<typeof StrategyOverrideSchema>;

// ---------------------------------------------------------------------------
// Parse result — explicit union, no exceptions
// ---------------------------------------------------------------------------

export type ParseStrategyResult =
  | { ok: true; strategy: StrategyOverride }
  | { ok: false; error: string };

/**
 * Parse and validate a raw strategy JSON value.
 * Returns a typed result — never throws.
 * On failure: caller should trigger HaltProtocol.
 */
export function parseStrategy(raw: unknown): ParseStrategyResult {
  const result = StrategyOverrideSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, strategy: result.data };
}

/**
 * Convert a validated StrategyOverride into system-prompt override clauses.
 * Returns an array of clause strings to be injected into the LLM context.
 */
export function strategyToPromptClauses(strategy: StrategyOverride): string[] {
  const clauses: string[] = [];

  // Directional bias
  if (strategy.bias === "long-only") {
    clauses.push(
      "DIRECTIVE: You are operating in LONG-ONLY mode. Do NOT open short positions under any circumstances.",
    );
  } else if (strategy.bias === "short-only") {
    clauses.push(
      "DIRECTIVE: You are operating in SHORT-ONLY mode. Do NOT open long positions under any circumstances.",
    );
  } else {
    clauses.push(
      "DIRECTIVE: You may trade both long and short positions as your analysis dictates.",
    );
  }

  // Max drawdown
  clauses.push(
    `RISK LIMIT: Maximum allowed drawdown is ${(strategy.maxDrawdown * 100).toFixed(1)}%. If this threshold is breached, halt immediately.`,
  );

  // Allowed assets
  clauses.push(
    `ALLOWED ASSETS: Only trade the following instruments: ${strategy.allowedAssets.join(", ")}.`,
  );

  // Confluence threshold
  clauses.push(
    `CONFLUENCE GATE: Execute trades only when at least ${strategy.confluenceThreshold} independent signals are aligned.`,
  );

  // Entry conditions (if structured as named rules)
  for (const [conditionName, conditionValue] of Object.entries(strategy.entryConditions)) {
    clauses.push(`ENTRY CONDITION [${conditionName}]: ${JSON.stringify(conditionValue)}`);
  }

  // Exit rules
  for (const [ruleName, ruleValue] of Object.entries(strategy.exitRules)) {
    clauses.push(`EXIT RULE [${ruleName}]: ${JSON.stringify(ruleValue)}`);
  }

  return clauses;
}
