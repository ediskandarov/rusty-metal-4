import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

export const root = resolve(import.meta.dir, "..");
export function options(names, args = process.argv.slice(2)) {
  return parseArgs({
    args,
    options: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
  }).values;
}
export async function run(command, { cwd = root, capture = false } = {}) {
  const child = Bun.spawn(command, {
    cwd,
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = capture ? await new Response(child.stdout).text() : "";
  const status = await child.exited;
  if (status !== 0) throw new Error(`${command[0]} failed (${status})`);
  return output;
}
export async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  if ((await readFile(path, "utf8").catch(() => null)) !== text) await writeFile(path, text);
}
export const json = async (path) => JSON.parse(await readFile(path, "utf8"));
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
