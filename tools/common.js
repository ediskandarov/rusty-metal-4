import { mkdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

export const root = resolve(import.meta.dir, "..");
export function options(names, args = process.argv.slice(2)) {
  return parseArgs({
    args,
    options: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
  }).values;
}
export async function write(path, text) {
  if (
    (await Bun.file(path)
      .text()
      .catch(() => null)) !== text
  )
    await Bun.write(path, text);
}
export const json = async (path) => Bun.file(path).json();
export async function buildPath(path) {
  if (!path) throw new Error("An output directory is required");
  const output = resolve(path);
  const build = resolve(root, "build");
  const inside = (candidate) => {
    const part = relative(build, candidate);
    return part && !part.startsWith(`..${sep}`) && part !== ".." && !part.startsWith(sep);
  };
  if (!inside(output)) throw new Error("Output must be inside build/");
  await mkdir(dirname(output), { recursive: true });
  const parent = await realpath(dirname(output));
  if (parent !== build && !inside(parent))
    throw new Error("Output escapes build/ through a symlink");
  return output;
}
