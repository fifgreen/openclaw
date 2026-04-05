import { Queue } from "bullmq";
import type { Redis } from "ioredis";

/**
 * Creates the BullMQ queue for sentiment poll jobs.
 * 3 attempts with exponential backoff; max delay capped at 60 s.
 */
export function createSentimentQueue(redisClient: Redis): Queue {
  return new Queue("trading:sentiment:poll", {
    connection: redisClient,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
    },
  });
}

/**
 * Creates the BullMQ queue for async embedding pipeline jobs.
 * 5 attempts with exponential backoff; max delay capped at 300 s.
 */
export function createEmbedQueue(redisClient: Redis): Queue {
  return new Queue("sentiment:embed", {
    connection: redisClient,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
    },
  });
}
