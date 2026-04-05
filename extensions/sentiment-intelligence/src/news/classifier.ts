import axios from "axios";
import type { NewsEvent } from "../schema/NewsEvent.js";

type ClassifyResult = {
  impactClass: NewsEvent["impactClass"];
  sentiment: NewsEvent["sentiment"];
  confidence: number;
};

// Tier 1 keyword sets
const KEYWORD_SETS: Array<{ pattern: RegExp; impactClass: NewsEvent["impactClass"] }> = [
  { pattern: /\b(SEC|CFTC|ban|law|regulation|lawsuit|fine)\b/i, impactClass: "regulatory" },
  { pattern: /\b(exploit|hack|stolen|breach|compromised|theft)\b/i, impactClass: "hack" },
  {
    pattern: /\b(ETF|hedge fund|treasury|adoption|institutional|BlackRock|Fidelity)\b/i,
    impactClass: "institutional",
  },
  { pattern: /\b(upgrade|fork|testnet|protocol|mainnet|migration)\b/i, impactClass: "technical" },
  { pattern: /\b(Fed|interest rate|CPI|GDP|inflation|FOMC|yield)\b/i, impactClass: "macro" },
];

const POSITIVE_PATTERN = /\b(approval|surge|rally|bullish|partnerships|record)\b/i;
const NEGATIVE_PATTERN =
  /\b(crash|reject|ban|scam|fraud|collapse|plunge|exploit|drain|drains|stolen|hack|breach)\b/i;

function tier1(headline: string): ClassifyResult {
  const matches: Array<NewsEvent["impactClass"]> = [];
  for (const { pattern, impactClass } of KEYWORD_SETS) {
    if (pattern.test(headline)) matches.push(impactClass);
  }

  const impactClass: NewsEvent["impactClass"] = matches[0] ?? "other";
  const isPositive = POSITIVE_PATTERN.test(headline);
  const isNegative = NEGATIVE_PATTERN.test(headline);
  const sentiment: NewsEvent["sentiment"] =
    isPositive && !isNegative ? "positive" : isNegative && !isPositive ? "negative" : "neutral";

  const confidence = matches.length >= 2 ? 0.9 : matches.length === 1 ? 0.65 : 0.5;
  return { impactClass, sentiment, confidence };
}

export interface ClassifierOptions {
  ollamaBaseUrl?: string;
  ollamaClassifyModel?: string;
}

/**
 * Classifies a headline into an impact class, sentiment, and confidence score.
 * Tier 1 (synchronous, keyword-based) runs always.
 * Tier 2 (async, Ollama LLM) runs only when Tier 1 confidence < 0.6.
 */
export async function classify(
  headline: string,
  opts: ClassifierOptions = {},
): Promise<ClassifyResult> {
  const t1 = tier1(headline);
  if (t1.confidence >= 0.6) return t1;

  // Tier 2 — fallback to Ollama when confidence is low
  const { ollamaBaseUrl = "http://localhost:11434", ollamaClassifyModel = "llama3.2" } = opts;
  try {
    const prompt =
      `Classify this crypto news headline. Reply with a JSON object with fields: ` +
      `impactClass (one of: regulatory, macro, technical, hack, institutional, other), ` +
      `sentiment (positive/negative/neutral), confidence (0-1).\n\nHeadline: "${headline}"`;

    const res = await axios.post<{ response: string }>(
      `${ollamaBaseUrl}/api/generate`,
      { model: ollamaClassifyModel, prompt, stream: false },
      { timeout: 10_000 },
    );

    // Parse JSON embedded in the model's response text
    const match = /\{[\s\S]*\}/.exec(res.data.response);
    if (!match) return t1;

    const parsed: unknown = JSON.parse(match[0]);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "impactClass" in parsed &&
      "sentiment" in parsed &&
      "confidence" in parsed
    ) {
      const p = parsed as { impactClass: string; sentiment: string; confidence: number };
      const VALID_IMPACT = new Set([
        "regulatory",
        "macro",
        "technical",
        "hack",
        "institutional",
        "other",
      ]);
      const VALID_SENTIMENT = new Set(["positive", "negative", "neutral"]);
      if (VALID_IMPACT.has(p.impactClass) && VALID_SENTIMENT.has(p.sentiment)) {
        return {
          impactClass: p.impactClass as NewsEvent["impactClass"],
          sentiment: p.sentiment as NewsEvent["sentiment"],
          confidence: Math.min(1, Math.max(0, p.confidence)),
        };
      }
    }
    return t1;
  } catch {
    // Ollama unavailable or parse failure → return Tier 1 result
    return t1;
  }
}
