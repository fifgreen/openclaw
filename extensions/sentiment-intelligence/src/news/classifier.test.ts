import { describe, it, expect, vi } from "vitest";
import { classify } from "./classifier.js";

vi.mock("axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
import axios from "axios";

describe("classify — Tier 1", () => {
  it("'Bitcoin ETF approval' → institutional / positive", async () => {
    const result = await classify("Bitcoin ETF approval by SEC");
    // Both "ETF" (institutional) and "SEC" (regulatory) match → confidence 0.9
    // "approval" hits positive pattern
    expect(result.impactClass).toMatch(/institutional|regulatory/);
    expect(result.sentiment).toBe("positive");
    expect(result.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it("'Ethereum exploit drains $50M' → hack / negative", async () => {
    const result = await classify("Ethereum exploit drains $50M from DeFi protocol");
    expect(result.impactClass).toBe("hack");
    expect(result.sentiment).toBe("negative");
    expect(result.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it("returns other/neutral with confidence 0.5 for ambiguous headline", async () => {
    const result = await classify("Crypto market sees mixed signals today");
    expect(result.impactClass).toBe("other");
    expect(result.sentiment).toBe("neutral");
    expect(result.confidence).toBe(0.5);
  });
});

describe("classify — Tier 2 Ollama fallback", () => {
  it("calls Ollama for low-confidence headline", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: {
        response: JSON.stringify({
          impactClass: "macro",
          sentiment: "neutral",
          confidence: 0.75,
        }),
      },
    });

    const result = await classify("Market observers note a pattern", {
      ollamaBaseUrl: "http://localhost:11434",
      ollamaClassifyModel: "llama3.2",
    });

    expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
      expect.stringContaining("/api/generate"),
      expect.objectContaining({ model: "llama3.2" }),
      expect.anything(),
    );
    expect(result.impactClass).toBe("macro");
  });

  it("falls back to Tier 1 if Ollama is unreachable", async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await classify("Unknown thing happens in markets", {
      ollamaBaseUrl: "http://localhost:11434",
    });

    expect(result.impactClass).toBe("other");
    expect(result.confidence).toBe(0.5);
  });
});
