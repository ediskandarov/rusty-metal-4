import { z } from "zod";

import { converterFilePattern, tm3ConverterPath } from "./converter-paths.ts";
import { type ModDraft, sha256 } from "./package.ts";

export interface RecipeInput {
  modDisc: readonly File[];
  baseDisc: readonly File[];
  progress: (message: string) => void;
}

export interface DiscModConverter {
  build(inputs: RecipeInput): Promise<ModDraft>;
}

export const converterReleaseSchema = z.strictObject({
  format: z.literal(1),
  id: z.literal("tm3"),
  version: z.string().min(1).max(80),
  runtime: z.string().regex(/^[a-f0-9]{64}$/),
  files: z
    .array(
      z.strictObject({
        path: z.string().regex(converterFilePattern),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(2)
    .max(64)
    .refine((files) => {
      const paths = new Set(files.map(({ path }) => path));
      return paths.has("converter.js") && paths.size === files.length;
    }, "Invalid TM3 converter file inventory"),
});

export const converterPinSchema = z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) });

export async function loadTm3Converter(origin: string) {
  const root = new URL(tm3ConverterPath, origin);
  const response = await fetch(new URL("pin.json", root), { cache: "no-store" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw Error(`Could not load TM3 converter pin: HTTP ${response.status}`);
  const { digest } = converterPinSchema.parse(await response.json());
  const directory = new URL(digest + "/", root);
  const manifest = await fetch(new URL("release.json", directory));
  if (!manifest.ok) throw Error("Could not load the TM3 converter release");
  const bytes = new Uint8Array(await manifest.arrayBuffer());
  return { directory, release: await readConverterRelease(bytes, digest) };
}

export async function readConverterRelease(bytes: Uint8Array<ArrayBuffer>, expected?: string) {
  if (expected && (await sha256(bytes)) !== expected)
    throw Error("TM3 converter release does not match its pin");
  return converterReleaseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export interface ConverterRequest {
  converter: string;
  runtime: string;
  version: string;
  modDisc: File[];
  baseDisc: File[];
}

export type ConverterReply =
  | { type: "progress"; message: string }
  | { type: "built"; bytes: ArrayBuffer }
  | { type: "error"; message: string };
