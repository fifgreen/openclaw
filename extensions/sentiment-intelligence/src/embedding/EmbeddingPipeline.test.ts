import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock("bullmq");
vi.mock("../schema/SentimentSnapshot.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../schema/SentimentSnapshot.js")>();
  return orig;
});

import axios from "axios";
import { startEmbeddingPipeline, enqueueEmbedJob } from "./EmbeddingPipeline.js";

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockPool = { query: mockQuery } as unknown as import("pg").Pool;
const mockRedis = {} as import("ioredis").Redis;

const validPayload = {
  symbol: "BTC",
  fearGreedScore: 0.72,
  fearGreedLabel: "greed",
  twitterScore: 0.65,
  tweetVolume: 12000,
  redditScore: 0.55,
  redditPostVolume: 800,
  fundingBias: "long",
  fundingRate: 0.0001,
  compositeScore: 0.7,
  lastUpdated: "2025-01-15T09:00:00.000Z",
};

describe("startEmbeddingPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("starts a BullMQ Worker on sentiment:embed queue", async () => {
    const { Worker } = vi.mocked(await import("bullmq"));
    startEmbeddingPipeline(mockRedis, mockPool, {
      ollamaBaseUrl: "http://localhost:11434",
      ollamaEmbedModel: "nomic-embed-text",
    });
    expect(Worker).toHaveBeenCalledWith(
      "sentiment:embed",
      expect.any(Function),
      expect.objectContaining({ connection: mockRedis }),
    );
  });
});

describe("enqueueEmbedJob", () => {
  it("adds a job with deterministic jobId", async () => {
    const mockQueue = { add: vi.fn() };
    await enqueueEmbedJob(mockQueue as never, {
      type: "sentiment",
      symbol: "BTC",
      timestamp: "2025-01-15T09:00:00.000Z",
      payload: validPayload,
    });
    expect(mockQueue.add).toHaveBeenCalledWith(
      "embed",
      expect.objectContaining({ symbol: "BTC" }),
      expect.objectContaining({ jobId: "embed:sentiment:BTC:2025-01-15T09:00:00.000Z" }),
    );
  });

  it("duplicate job with same (type, symbol, timestamp) has same jobId (idempotent)", async () => {
    const mockQueue = { add: vi.fn() };
    const jobData = {
      type: "sentiment" as const,
      symbol: "BTC",
      timestamp: "2025-01-15T09:00:00.000Z",
      payload: validPayload,
    };
    await enqueueEmbedJob(mockQueue as never, jobData);
    await enqueueEmbedJob(mockQueue as never, jobData);
    // Both calls use same jobId for idempotency (BullMQ deduplicates by jobId)
    const firstJobId = (mockQueue.add.mock.calls[0] as unknown[])[2];
    const secondJobId = (mockQueue.add.mock.calls[1] as unknown[])[2];
    expect(firstJobId).toEqual(secondJobId);
  });
});

describe("Ollama 768-dim embedding integration flow", () => {
  it("calls Ollama and upserts embedding on valid response", async () => {
    const fakeEmbedding = new Array(768).fill(0.1);
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { embedding: fakeEmbedding } });

    // Start the pipeline — Worker constructor is auto-mocked via vi.mock("bullmq")
    const { Worker } = await import("bullmq");
    startEmbeddingPipeline(mockRedis, mockPool, {
      ollamaBaseUrl: "http://localhost:11434",
      ollamaEmbedModel: "nomic-embed-text",
    });

    // Extract the processor function from the constructor call args
    const MockWorker = vi.mocked(Worker);
    const processorFn = MockWorker.mock.calls[MockWorker.mock.calls.length - 1]?.[1] as
      | ((job: { data: unknown }) => Promise<void>)
      | undefined;

    expect(processorFn).toBeDefined();

    await processorFn!({
      data: {
        type: "sentiment",
        symbol: "BTC",
        timestamp: "2025-01-15T09:00:00.000Z",
        payload: validPayload,
      },
    });

    expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
      "http://localhost:11434/api/embeddings",
      expect.objectContaining({ model: "nomic-embed-text" }),
      expect.anything(),
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (type, timestamp, symbol) DO NOTHING"),
      expect.arrayContaining(["sentiment", "BTC"]),
    );
  });
});
