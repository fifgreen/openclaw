import { createMemDir } from "@openclaw/trading-context/src/memdir/MemDir.js";
import axios from "axios";
import type { Queue } from "bullmq";
import type { Pool } from "pg";
import { upsertMacroSnapshot, queryLatestMacroSnapshot } from "../db/queries.js";
import { FredFeed, type FredFeedResult } from "../feeds/FredFeed.js";
import type { MacroContext } from "../schema/MacroSnapshot.js";
import { classifyRegime, type RegimeRules } from "../sentiment/regime-classifier.js";

const FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const CPI_URL = "https://www.bls.gov/schedule/news_release/cpi.htm";

// Matches YYYY-MM-DD dates in scraped HTML
const DATE_REGEX = /\d{4}-\d{2}-\d{2}/;
// Matches FOMC meeting outcome labels in scraped HTML
const FOMC_ACTION_REGEX = /\b(hike|cut|hold)\b/i;

export interface MacroSchedulerOptions {
  fredFeed: FredFeed;
  memDir: ReturnType<typeof createMemDir>;
  pool: Pool;
  queue: Queue;
  regimeRules?: Partial<RegimeRules>;
}

export interface MacroSchedulerHandle {
  /** Dispatch a macro queue job by name (call from BullMQ Worker). */
  handleJob(jobName: string): Promise<void>;
  /** Remove all registered repeatable jobs. */
  cleanup(): Promise<void>;
}

function parseNextDateFromHtml(html: string): string | null {
  const match = DATE_REGEX.exec(html);
  return match ? match[0] : null;
}

function parseFomcActionFromHtml(html: string): "hold" | "cut" | "hike" | null {
  const match = FOMC_ACTION_REGEX.exec(html);
  if (!match) return null;
  return match[1]!.toLowerCase() as "hold" | "cut" | "hike";
}

/**
 * Reads the latest macro snapshots from DB, assembles a MacroContext,
 * classifies the regime, and writes to MemDir.
 */
export async function buildMacroContext(
  pool: Pool,
  memDir: ReturnType<typeof createMemDir>,
  regimeRules?: Partial<RegimeRules>,
): Promise<MacroContext> {
  const rows = await queryLatestMacroSnapshot(pool);

  // Map series_id → value
  const byId = new Map<string, number>();
  for (const row of rows) {
    byId.set(row.series_id as string, row.value as number);
  }

  // Decode fomcLastAction from stored numeric encoding (hike=1, hold=0, cut=-1)
  const fomcActionValue = byId.get("fomcLastAction");
  const fomcLastAction: MacroContext["fomcLastAction"] =
    fomcActionValue === 1
      ? "hike"
      : fomcActionValue === -1
        ? "cut"
        : fomcActionValue === 0
          ? "hold"
          : null;

  // Decode date timestamps stored as unix ms
  const fomcNextDateMs = byId.get("fomcNextDate");
  const fomcNextDate = fomcNextDateMs ? new Date(fomcNextDateMs).toISOString().slice(0, 10) : null;
  const cpiNextDateMs = byId.get("cpiNextDate");
  const cpiNextDate = cpiNextDateMs ? new Date(cpiNextDateMs).toISOString().slice(0, 10) : null;

  const macro: MacroContext = {
    dxy: byId.get("DTWEXBGS") ?? null,
    us10y: byId.get("DGS10") ?? null,
    m2Supply: byId.get("M2SL") ?? null,
    oilPriceWti: byId.get("DCOILWTICO") ?? null,
    globalMarketCap: byId.get("globalMarketCap") ?? null,
    btcDominance: byId.get("btcDominance") ?? null,
    fomcNextDate,
    fomcLastAction,
    cpiLastReading: byId.get("cpiLast") ?? null,
    cpiNextDate,
    regime: classifyRegime(
      {
        dxy: byId.get("DTWEXBGS") ?? null,
        us10y: byId.get("DGS10") ?? null,
        fomcLastAction,
      },
      regimeRules,
    ),
    lastUpdated: new Date().toISOString(),
  };

  await memDir.set({ key: "macro_snapshot", symbol: "*" }, macro, {
    ttlMs: 86_400_000,
    source: "MacroScheduler",
  });

  return macro;
}

/**
 * Registers all BullMQ RepeatableJobs for macro data collection.
 * Returns a handle with `handleJob` (for use in a BullMQ Worker) and `cleanup`.
 */
export async function registerMacroJobs(
  opts: MacroSchedulerOptions,
): Promise<MacroSchedulerHandle> {
  const { fredFeed, memDir, pool, queue, regimeRules } = opts;

  // 1. fred-daily — pull FRED series daily
  await queue.add(
    "fred-daily",
    { type: "fred" },
    { repeat: { pattern: "0 9 * * *" }, jobId: "fred-daily:repeat" },
  );

  // 2. fomc-weekly — scrape FOMC meeting calendar
  await queue.add(
    "fomc-weekly",
    { type: "fomc" },
    { repeat: { pattern: "0 9 * * 1" }, jobId: "fomc-weekly:repeat" },
  );

  // 3. cpi-weekly — scrape BLS CPI release calendar
  await queue.add(
    "cpi-weekly",
    { type: "cpi" },
    { repeat: { pattern: "0 9 * * 1" }, jobId: "cpi-weekly:repeat" },
  );

  // 4. macro-context-build — rebuild composite context (triggered after fred-daily/fomc)
  await queue.add(
    "macro-context-build",
    { type: "build" },
    { repeat: { pattern: "30 9 * * *" }, jobId: "macro-context-build:repeat" },
  );

  /**
   * Worker handler — call this from your BullMQ Worker for the macro queue.
   * This processes job payloads dispatched by the registered jobs above.
   */
  async function handleJob(jobName: string): Promise<void> {
    if (jobName === "fred-daily") {
      let result: FredFeedResult;
      try {
        result = await fredFeed.poll();
      } catch (err) {
        console.error("[MacroScheduler] FredFeed.poll() failed:", (err as Error).message);
        await memDir.set(
          { key: "sentiment_health", symbol: "fred" },
          { lastSuccessfulPoll: new Date(0).toISOString(), isStale: true },
          { ttlMs: null, source: "MacroScheduler" },
        );
        return;
      }

      // Upsert each FRED series as a narrow row (skip null values)
      const upserts = [];
      if (result.dxy != null)
        upserts.push(
          upsertMacroSnapshot(pool, {
            series_id: "DTWEXBGS",
            value: result.dxy,
            unit: "index",
            effective_date: result.effectiveDate,
          }),
        );
      if (result.us10y != null)
        upserts.push(
          upsertMacroSnapshot(pool, {
            series_id: "DGS10",
            value: result.us10y,
            unit: "pct",
            effective_date: result.effectiveDate,
          }),
        );
      if (result.m2Supply != null)
        upserts.push(
          upsertMacroSnapshot(pool, {
            series_id: "M2SL",
            value: result.m2Supply,
            unit: "billions_usd",
            effective_date: result.effectiveDate,
          }),
        );
      if (result.oilPriceWti != null)
        upserts.push(
          upsertMacroSnapshot(pool, {
            series_id: "DCOILWTICO",
            value: result.oilPriceWti,
            unit: "usd_bbl",
            effective_date: result.effectiveDate,
          }),
        );
      if (result.globalMarketCap != null)
        upserts.push(
          upsertMacroSnapshot(pool, {
            series_id: "globalMarketCap",
            value: result.globalMarketCap,
            unit: "usd",
            effective_date: result.effectiveDate,
          }),
        );
      if (result.btcDominance != null)
        upserts.push(
          upsertMacroSnapshot(pool, {
            series_id: "btcDominance",
            value: result.btcDominance,
            unit: "pct",
            effective_date: result.effectiveDate,
          }),
        );

      await Promise.all(upserts);

      await memDir.set(
        { key: "sentiment_health", symbol: "fred" },
        { lastSuccessfulPoll: new Date().toISOString(), isStale: false },
        { ttlMs: null, source: "MacroScheduler" },
      );

      await buildMacroContext(pool, memDir, regimeRules);
    }

    if (jobName === "fomc-weekly") {
      try {
        const res = await axios.get<string>(FOMC_URL, { timeout: 15_000 });
        const nextDate = parseNextDateFromHtml(res.data);
        const lastAction = parseFomcActionFromHtml(res.data);
        const effectiveDate = new Date().toISOString().slice(0, 10);
        if (nextDate)
          await upsertMacroSnapshot(pool, {
            series_id: "fomcNextDate",
            value: new Date(nextDate).getTime(),
            unit: "unix_ms",
            effective_date: effectiveDate,
          });
        if (lastAction) {
          // Encode action as numeric: hike=1, hold=0, cut=-1
          const actionValue = lastAction === "hike" ? 1 : lastAction === "cut" ? -1 : 0;
          await upsertMacroSnapshot(pool, {
            series_id: "fomcLastAction",
            value: actionValue,
            unit: "enum",
            effective_date: effectiveDate,
          });
        }
        await buildMacroContext(pool, memDir, regimeRules);
      } catch (err) {
        console.error("[MacroScheduler] FOMC scrape failed:", (err as Error).message);
        // Retain last known values in MemDir
        const existing = await memDir.get({ key: "macro_snapshot", symbol: "*" });
        if (existing) {
          // Write back with null FOMC fields to signal staleness
          await memDir.set(
            { key: "macro_snapshot", symbol: "*" },
            { ...existing.value, fomcNextDate: null, lastUpdated: new Date().toISOString() },
            { ttlMs: 86_400_000, source: "MacroScheduler" },
          );
        }
      }
    }

    if (jobName === "cpi-weekly") {
      try {
        const res = await axios.get<string>(CPI_URL, { timeout: 15_000 });
        const nextDate = parseNextDateFromHtml(res.data);
        if (nextDate) {
          const effectiveDate = new Date().toISOString().slice(0, 10);
          await upsertMacroSnapshot(pool, {
            series_id: "cpiNextDate",
            value: new Date(nextDate).getTime(),
            unit: "unix_ms",
            effective_date: effectiveDate,
          });
        }
      } catch (err) {
        console.error("[MacroScheduler] CPI scrape failed:", (err as Error).message);
        const existing = await memDir.get({ key: "macro_snapshot", symbol: "*" });
        if (existing) {
          await memDir.set(
            { key: "macro_snapshot", symbol: "*" },
            { ...existing.value, cpiNextDate: null, lastUpdated: new Date().toISOString() },
            { ttlMs: 86_400_000, source: "MacroScheduler" },
          );
        }
      }
    }

    if (jobName === "macro-context-build") {
      await buildMacroContext(pool, memDir, regimeRules);
    }
  }

  return {
    handleJob,
    cleanup: async () => {
      await queue.removeRepeatable("fred-daily", { pattern: "0 9 * * *" });
      await queue.removeRepeatable("fomc-weekly", { pattern: "0 9 * * 1" });
      await queue.removeRepeatable("cpi-weekly", { pattern: "0 9 * * 1" });
      await queue.removeRepeatable("macro-context-build", { pattern: "30 9 * * *" });
    },
  };
}
