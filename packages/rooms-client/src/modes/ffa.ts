import { z } from "zod";

import { text } from "../fields.ts";
export const ffaCapacity = 8;
export const ffaOptionsSchema = z
  .object({
    bots: z.array(text(48)).max(ffaCapacity - 1),
    humanLimit: z.number().int().min(1).max(ffaCapacity),
  })
  .strict()
  .refine(
    (options) => options.humanLimit + options.bots.length <= ffaCapacity,
    "Human and bot quotas must fit within eight places",
  );
export const ffa = {
  id: "ffa",
  label: "Free for all",
  capacity: ffaCapacity,
  capacityError: "Free for all always has eight player places.",
  minimumPlayers: 1,
  bots(options?: { ffa: z.infer<typeof ffaOptionsSchema> }) {
    return options?.ffa.bots ?? [];
  },
  humanLimit(options?: { ffa: z.infer<typeof ffaOptionsSchema> }) {
    return options?.ffa.humanLimit ?? ffaCapacity;
  },
  validSettings(_settings: {
    mapId: string;
    modeOptions?: { ffa: z.infer<typeof ffaOptionsSchema> };
  }) {
    return true;
  },
} as const;
