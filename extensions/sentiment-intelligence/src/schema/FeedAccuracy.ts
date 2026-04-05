import { z } from "zod";

const FeedAccuracyEntrySchema = z.object({
  feedId: z.string(),
  lastSuccessfulPoll: z.string(),
  isStale: z.boolean(),
  accuracy30d: z.number().nullable(),
  sampleCount: z.number().int(),
  weight: z.number().min(0),
});

export const FeedAccuracyReportSchema = z.object({
  feeds: z.array(FeedAccuracyEntrySchema),
});

export type FeedAccuracyReport = z.infer<typeof FeedAccuracyReportSchema>;
export type FeedAccuracyEntry = z.infer<typeof FeedAccuracyEntrySchema>;
