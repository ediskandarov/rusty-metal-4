import { z } from "zod";
export const discManifestSchema = z.object({
  files: z.array(
    z.object({
      name: z.string().min(1),
      size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      url: z.string().min(1),
    }),
  ),
  warnings: z.array(z.string()).default([]),
});
export type DiscManifest = z.infer<typeof discManifestSchema>;
