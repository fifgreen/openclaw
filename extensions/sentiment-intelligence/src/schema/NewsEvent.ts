import { z } from "zod";

export const NewsEventSchema = z
  .object({
    id: z.number().int(),
    headline: z.string(),
    source: z.string(),
    url: z.string(),
    sentiment: z.enum(["positive", "negative", "neutral"]),
    impactClass: z.enum(["regulatory", "macro", "technical", "hack", "institutional", "other"]),
    classificationConfidence: z.number().min(0).max(1),
    symbols: z.array(z.string()),
    publishedAt: z.string(),
  })
  .strip(); // extra fields stripped

export type NewsEvent = z.infer<typeof NewsEventSchema>;
