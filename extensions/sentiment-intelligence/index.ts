import type { MemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { Pool } from "pg";
import type { OpenClawPluginApi } from "./runtime-api.js";
import { buildGetFeedAccuracyTool } from "./src/tools/get-feed-accuracy.js";
import { buildGetMacroContextTool } from "./src/tools/get-macro-context.js";
import { buildGetNewsEventsTool } from "./src/tools/get-news-events.js";
import type { GetNewsEventsOptions } from "./src/tools/get-news-events.js";
import { buildGetSentimentTool } from "./src/tools/get-sentiment.js";

export * from "./src/api.js";

export default definePluginEntry({
  id: "sentiment-intelligence",
  name: "Sentiment Intelligence",
  description:
    "Fear & Greed, Reddit, Twitter, CryptoPanic feeds, macro regime classifier, pgvector embeddings, and feed accuracy scoring for trading agents",
  register(api: OpenClawPluginApi) {
    // Shared singletons — set during start(), used by lazily-called tool factories.
    let sharedMemDir: MemDir | undefined;
    let sharedPool: Pool | undefined;
    let sharedNewsOpts: GetNewsEventsOptions = {};

    api.registerService({
      id: "sentiment-intelligence",
      async start(ctx) {
        const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

        const symbols: string[] = Array.isArray(cfg["symbols"])
          ? (cfg["symbols"] as unknown[]).map(String)
          : ["BTC", "ETH"];

        const postgresUrl = typeof cfg["postgresUrl"] === "string" ? cfg["postgresUrl"] : undefined;
        const redisUrl =
          typeof cfg["redisUrl"] === "string" ? cfg["redisUrl"] : "redis://localhost:6379";
        const ollamaBaseUrl =
          typeof cfg["ollamaBaseUrl"] === "string"
            ? cfg["ollamaBaseUrl"]
            : "http://localhost:11434";
        const ollamaEmbedModel =
          typeof cfg["ollamaEmbedModel"] === "string"
            ? cfg["ollamaEmbedModel"]
            : "nomic-embed-text";
        const ollamaClassifyModel =
          typeof cfg["ollamaClassifyModel"] === "string" ? cfg["ollamaClassifyModel"] : "llama3.2";
        const alertChannelId =
          typeof cfg["alertChannelId"] === "string" ? cfg["alertChannelId"] : undefined;

        // Credentials (never logged)
        const twitterBearerToken =
          typeof cfg["twitterBearerToken"] === "string" ? cfg["twitterBearerToken"] : undefined;
        const nitterBaseUrl =
          typeof cfg["nitterBaseUrl"] === "string" ? cfg["nitterBaseUrl"] : undefined;
        const fredApiKey = typeof cfg["fredApiKey"] === "string" ? cfg["fredApiKey"] : "";
        const coinMarketCapApiKey =
          typeof cfg["coinMarketCapApiKey"] === "string" ? cfg["coinMarketCapApiKey"] : undefined;
        const cryptoPanicApiKey =
          typeof cfg["cryptoPanicApiKey"] === "string" ? cfg["cryptoPanicApiKey"] : undefined;

        const newsDefaultLimit =
          typeof cfg["newsDefaultLimit"] === "number" ? cfg["newsDefaultLimit"] : 10;
        const newsMaxLimit = typeof cfg["newsMaxLimit"] === "number" ? cfg["newsMaxLimit"] : 50;
        sharedNewsOpts = { newsDefaultLimit, newsMaxLimit };

        ctx.logger.info(`[sentiment-intelligence] starting — symbols=${symbols.join(",")}`);

        // 1. DB pool + migration
        const { configurePool, getPool, closePool, runMigrations } =
          await import("./src/db/client.js");
        if (postgresUrl) configurePool(postgresUrl);
        const pool = getPool();
        sharedPool = pool;
        await runMigrations(pool);

        // 2. Redis + MemDir
        const { getRedisClient } = await import("@openclaw/trading-context/src/memdir/index.js");
        const { createMemDir } = await import("@openclaw/trading-context/src/memdir/MemDir.js");
        const redis = getRedisClient({ url: redisUrl });
        const memDir = createMemDir({ client: redis });
        sharedMemDir = memDir;

        // 3. BullMQ queues
        const { createSentimentQueue, createEmbedQueue } = await import("./src/infra/queues.js");
        const sentimentQueue = createSentimentQueue(redis);
        const embedQueue = createEmbedQueue(redis);

        // 4. Feeds
        const { FearGreedFeed } = await import("./src/feeds/FearGreedFeed.js");
        const { RedditFeed } = await import("./src/feeds/RedditFeed.js");
        const { TwitterFeed } = await import("./src/feeds/TwitterFeed.js");
        const { CryptoPanicFeed } = await import("./src/feeds/CryptoPanicFeed.js");
        const { FredFeed } = await import("./src/feeds/FredFeed.js");

        const fearGreedFeed = new FearGreedFeed({ memDir });
        const redditFeed = new RedditFeed({ memDir });
        const twitterFeed = new TwitterFeed({
          memDir,
          bearerToken: twitterBearerToken,
          nitterBaseUrl,
        });
        const cryptoPanicFeed = new CryptoPanicFeed({
          apiKey: cryptoPanicApiKey,
          pool,
          memDir,
          classifierOpts: { ollamaBaseUrl, ollamaClassifyModel },
        });
        const fredFeed = new FredFeed({ fredApiKey, coinMarketCapApiKey });

        // 5. Register BullMQ repeatable jobs via MacroScheduler
        const { registerMacroJobs } = await import("./src/macro/MacroScheduler.js");
        const macroHandle = await registerMacroJobs({
          fredFeed,
          memDir,
          pool,
          queue: sentimentQueue,
        });

        // BullMQ sentiment poll worker
        const { Worker, Queue } = await import("bullmq");
        const { aggregate } = await import("./src/sentiment/aggregator.js");

        const sentimentWorker = new Worker(
          "trading:sentiment:poll",
          async (job) => {
            const jobType = (job.data as Record<string, string>)["type"];
            if (jobType === "fear-greed") {
              await fearGreedFeed.poll();
              for (const sym of symbols) {
                await aggregate(sym, memDir, pool, { embedQueue }).catch((e: Error) =>
                  ctx.logger.warn(`[sentiment-intelligence] aggregate ${sym} failed: ${e.message}`),
                );
              }
            } else if (jobType === "reddit") {
              for (const sym of symbols) await redditFeed.poll(sym);
            } else if (jobType === "twitter") {
              for (const sym of symbols) await twitterFeed.poll(sym);
            } else if (jobType === "cryptopanic") {
              await cryptoPanicFeed.poll(symbols);
            } else {
              await macroHandle.handleJob(jobType ?? "");
            }
          },
          { connection: redis },
        );

        // Add repeatable poll jobs (idempotent by jobId)
        const fearGreedCron =
          typeof cfg["fearGreedIntervalCron"] === "string"
            ? cfg["fearGreedIntervalCron"]
            : "0 */4 * * *";
        const redditCron =
          typeof cfg["redditIntervalCron"] === "string" ? cfg["redditIntervalCron"] : "0 */4 * * *";
        const twitterCron =
          typeof cfg["twitterIntervalCron"] === "string"
            ? cfg["twitterIntervalCron"]
            : "0 */4 * * *";
        const newsCron =
          typeof cfg["newsIntervalCron"] === "string" ? cfg["newsIntervalCron"] : "*/30 * * * *";

        await sentimentQueue.add(
          "fear-greed",
          { type: "fear-greed" },
          { repeat: { pattern: fearGreedCron }, jobId: "fear-greed:repeat" },
        );
        await sentimentQueue.add(
          "reddit",
          { type: "reddit" },
          { repeat: { pattern: redditCron }, jobId: "reddit:repeat" },
        );
        await sentimentQueue.add(
          "twitter",
          { type: "twitter" },
          { repeat: { pattern: twitterCron }, jobId: "twitter:repeat" },
        );
        await sentimentQueue.add(
          "cryptopanic",
          { type: "cryptopanic" },
          { repeat: { pattern: newsCron }, jobId: "cryptopanic:repeat" },
        );

        // 6. Start EmbeddingPipeline worker
        const { startEmbeddingPipeline } = await import("./src/embedding/EmbeddingPipeline.js");
        const embedWorker = startEmbeddingPipeline(redis, pool, {
          ollamaBaseUrl,
          ollamaEmbedModel,
        });

        // 7. Start HealthMonitor worker
        const { startHealthMonitor } = await import("./src/health/HealthMonitor.js");
        const healthQueue = new Queue("sentiment:health", { connection: redis });
        const healthWorker = await startHealthMonitor({
          queue: healthQueue,
          memDir,
          alertChannelId,
          alert: alertChannelId
            ? ({ message }) => ctx.logger.warn(`[sentiment-health-alert] ${message}`)
            : undefined,
        });

        // Stash handles for stop()
        const ctx_ = ctx as Record<string, unknown>;
        ctx_["_si_sentimentWorker"] = sentimentWorker;
        ctx_["_si_embedWorker"] = embedWorker;
        ctx_["_si_healthWorker"] = healthWorker;
        ctx_["_si_closePool"] = closePool;
        ctx_["_si_macroHandle"] = macroHandle;
      },
      async stop(ctx) {
        ctx.logger.info("[sentiment-intelligence] stopping");
        const ctx_ = ctx as Record<string, unknown>;

        const sentimentWorker = ctx_["_si_sentimentWorker"] as
          | { close(): Promise<void> }
          | undefined;
        const embedWorker = ctx_["_si_embedWorker"] as { close(): Promise<void> } | undefined;
        const healthWorker = ctx_["_si_healthWorker"] as { close(): Promise<void> } | undefined;
        const macroHandle = ctx_["_si_macroHandle"] as { cleanup(): Promise<void> } | undefined;
        const closePool = ctx_["_si_closePool"] as (() => Promise<void>) | undefined;

        await Promise.allSettled([
          sentimentWorker?.close(),
          embedWorker?.close(),
          healthWorker?.close(),
          macroHandle?.cleanup(),
        ]);
        await closePool?.();
      },
    });

    // Tools are registered with lazy factories — called after start() sets the shared singletons.
    api.registerTool((_ctx) => buildGetSentimentTool(sharedMemDir!), { names: ["get_sentiment"] });
    api.registerTool((_ctx) => buildGetMacroContextTool(sharedMemDir!), {
      names: ["get_macro_context"],
    });
    api.registerTool((_ctx) => buildGetNewsEventsTool(sharedPool!, sharedNewsOpts), {
      names: ["get_news_events"],
    });
    api.registerTool((_ctx) => buildGetFeedAccuracyTool(sharedMemDir!, sharedPool!), {
      names: ["get_feed_accuracy"],
    });
  },
});
