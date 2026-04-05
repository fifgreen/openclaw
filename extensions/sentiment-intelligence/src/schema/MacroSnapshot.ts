import { z } from "zod";

export const MacroContextSchema = z.object({
  dxy: z.number().nullable(),
  us10y: z.number().nullable(),
  m2Supply: z.number().nullable(),
  oilPriceWti: z.number().nullable(),
  globalMarketCap: z.number().nullable(),
  btcDominance: z.number().nullable(),
  fomcNextDate: z.string().nullable(),
  fomcLastAction: z.enum(["hold", "cut", "hike"]).nullable(),
  cpiLastReading: z.number().nullable(),
  cpiNextDate: z.string().nullable(),
  regime: z.enum(["risk_on", "risk_off", "neutral", "uncertain"]),
  lastUpdated: z.string(),
});

export type MacroContext = z.infer<typeof MacroContextSchema>;
