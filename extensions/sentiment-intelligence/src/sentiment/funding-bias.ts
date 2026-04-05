import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";

export type FundingBiasResult = {
  bias: "long" | "short" | "neutral";
  rate: number;
};

const LONG_THRESHOLD = 0.00001;

/**
 * Reads the funding rate from MemDir (written by 002-market-data-ingestion).
 * Returns `{ bias: "neutral", rate: 0 }` if the key is absent or stale.
 */
export async function deriveFundingBias(
  symbol: string,
  memDir: ReturnType<typeof createMemDir>,
): Promise<FundingBiasResult> {
  const entry = await memDir.get({ key: "funding_rate", symbol });
  if (!entry) {
    return { bias: "neutral", rate: 0 };
  }

  const rate = entry.value.rate;
  let bias: "long" | "short" | "neutral";
  if (rate > LONG_THRESHOLD) {
    bias = "long";
  } else if (rate < -LONG_THRESHOLD) {
    bias = "short";
  } else {
    bias = "neutral";
  }

  return { bias, rate };
}
