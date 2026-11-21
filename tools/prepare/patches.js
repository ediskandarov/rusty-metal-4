import { join } from "node:path";

import { Glob } from "bun";

export async function readPatchSeries(directory) {
  const series = join(directory, "series");
  const names = (await Bun.file(series).text())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const remaining = new Set(
    await Array.fromAsync(new Glob("*.patch").scan({ cwd: directory, dot: true })),
  );
  const seen = new Set();
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]*\.patch$/.test(name))
      throw new Error(`Invalid patch name in ${series}: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate patch in ${series}: ${name}`);
    seen.add(name);
    if (!remaining.delete(name)) throw new Error(`Missing patch listed in ${series}: ${name}`);
  }
  if (remaining.size)
    throw new Error(`Patches missing from ${series}: ${[...remaining].sort().join(", ")}`);
  return names;
}
