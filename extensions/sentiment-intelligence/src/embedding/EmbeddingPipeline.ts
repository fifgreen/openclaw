import axios from "axios";
import { Worker, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { z } from "zod";
import { MacroContextSchema } from "../schema/MacroSnapshot.js";
import { SentimentSnapshotSchema } from "../schema/SentimentSnapshot.js";
import { serializeSentiment, serializeMacro } from "./serializer.js";

const OllamaEmbedResponseSchema = z.object({
  embedding: z.array(z.number()).length(768),
});

export interface EmbeddingPipelineConfig {
  ollamaBaseUrl: string;
  ollamaEmbedModel: string;
}

interface EmbedJobData {
  type: "sentiment" | "macro";
  symbol: string;
  timestamp: string;
  payload: unknown; // serialized snapshot or macro context
}

/**
 * Upserts a vector row into sentiment_embeddings.
 * ON CONFLICT (type, timestamp, symbol) DO NOTHING prevents re-embedding.
 */
async function upsertEmbedding(
  pool: Pool,
  row: {
    type: string;
    symbol: string;
    timestamp: string;
    regime: string;
    textChunk: string;
    embedding: number[];
    outcome?: string;
    pnlPct?: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO sentiment_embeddings
     (type, symbol, timestamp, regime, text_chunk, embedding)
     VALUES ($1, $2, $3, $4, $5, $6::vector(768))
     ON CONFLICT (type, timestamp, symbol) DO NOTHING`,
    [row.type, row.symbol, row.timestamp, row.regime, row.textChunk, JSON.stringify(row.embedding)],
  );
}

/**
 * Queries embedding metadata (without vectors) for a given symbol, sorted by timestamp DESC.
 */
export async function queryEmbeddingsBySymbol(
  pool: Pool,
  symbol: string,
  limit = 20,
): Promise<Array<{ id: number; type: string; timestamp: string; regime: string }>> {
  const result = await pool.query<{ id: number; type: string; timestamp: string; regime: string }>(
    `SELECT id, type, timestamp, regime
     FROM sentiment_embeddings
     WHERE symbol = $1
     ORDER BY timestamp DESC
     LIMIT $2`,
    [symbol, limit],
  );
  return result.rows;
}

/**
 * Starts a BullMQ Worker on the `sentiment:embed` queue.
 * For each job, serializes the payload, calls Ollama for a 768-dim vector,
 * and upserts into `sentiment_embeddings`.
 *
 * Retry policy: attempts 5, backoff base 5 s, cap 300 s.
 */
export function startEmbeddingPipeline(
  redis: Redis,
  pool: Pool,
  config: EmbeddingPipelineConfig,
): Worker {
  const worker = new Worker<EmbedJobData>(
    "sentiment:embed",
    async (job) => {
      const { type, symbol, timestamp, payload } = job.data;

      // Serialize the payload to a text chunk
      let textChunk: string;
      let regime = "neutral";

      if (type === "sentiment") {
        const parsed = SentimentSnapshotSchema.safeParse(payload);
        if (!parsed.success) {
          console.warn("[EmbeddingPipeline] Invalid sentiment payload, skipping embed");
          return;
        }
        textChunk = serializeSentiment(parsed.data);
      } else {
        const parsed = MacroContextSchema.safeParse(payload);
        if (!parsed.success) {
          console.warn("[EmbeddingPipeline] Invalid macro payload, skipping embed");
          return;
        }
        textChunk = serializeMacro(parsed.data);
        regime = parsed.data.regime;
      }

      // POST to Ollama embeddings endpoint
      const res = await axios.post<{ embedding: number[] }>(
        `${config.ollamaBaseUrl}/api/embeddings`,
        { model: config.ollamaEmbedModel, prompt: textChunk },
        { timeout: 30_000 },
      );

      const validated = OllamaEmbedResponseSchema.safeParse(res.data);
      if (!validated.success) {
        console.warn(
          "[EmbeddingPipeline] Ollama returned unexpected embedding shape:",
          validated.error.message,
        );
        throw new Error("Invalid embedding response");
      }

      await upsertEmbedding(pool, {
        type,
        symbol,
        timestamp,
        regime,
        textChunk,
        embedding: validated.data.embedding,
      });
    },
    {
      connection: redis,
      concurrency: 2,
    },
  );

  worker.on("failed", (job, err) => {
    console.warn(
      `[EmbeddingPipeline] Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`,
    );
  });

  return worker;
}

/**
 * Enqueues an embed job for a sentiment snapshot.
 * Called from SentimentAggregator after writing to MemDir.
 */
export async function enqueueEmbedJob(queue: Queue, data: EmbedJobData): Promise<void> {
  await queue.add("embed", data, {
    jobId: `embed:${data.type}:${data.symbol}:${data.timestamp}`,
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
  });
}
