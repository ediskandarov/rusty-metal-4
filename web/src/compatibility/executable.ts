import { sha256 } from "./hash.ts";

export const executableSizeTolerancePercent = 10;

export async function validateExecutable(
  bytes: Uint8Array<ArrayBuffer>,
  reference: { size: number; sha256: string },
) {
  const signature = new TextEncoder().encode("PS-X EXE");
  if (bytes.length < 2048 || !signature.every((byte, index) => bytes[index] === byte))
    throw new Error("Invalid PS-X EXE header");
  if ((await sha256(bytes)) === reference.sha256) return;
  const minimum = Math.ceil((reference.size * (100 - executableSizeTolerancePercent)) / 100);
  const maximum = Math.floor((reference.size * (100 + executableSizeTolerancePercent)) / 100);
  if (bytes.length < minimum || bytes.length > maximum)
    throw new Error(
      `Main EXE size is outside the supported range: expected ${minimum}–${maximum} bytes (±${executableSizeTolerancePercent}%), got ${bytes.length}`,
    );
}
