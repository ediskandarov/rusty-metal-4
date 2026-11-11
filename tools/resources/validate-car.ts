import { resolve } from "node:path";

import { readMr } from "@tm4/resources/compatibility/mr";
import { type CarDisplayOptions, validateCarMr } from "@tm4/resources/mods/car-display";
export { validateCarDisplay, validateCarMr } from "@tm4/resources/mods/car-display";

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function independentComparison(
  bytes: Uint8Array<ArrayBuffer>,
  input: string,
  referenceRoot: string,
) {
  const parsed = await readMr(bytes);
  const actual = [...parsed.directories]
    .flatMap(([path, directory]) =>
      [...directory.files].map(([name, entry]) => ({
        path: `${path}/${name}`,
        type: entry.type,
        array: entry.arraySize,
        sha: new Bun.CryptoHasher("sha256").update(entry.bytes).digest("hex"),
      })),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  const code = `import hashlib,json,sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1])/'tools'))\nfrom overlay_resources import MR\nm=MR(Path(sys.argv[2]).read_bytes())\nprint(json.dumps([{'path':'/'.join(e['parts']),'type':e['type'],'array':e['array_size'],'sha':hashlib.sha256(e['_payload']).hexdigest()} for e in m.entries]))`;
  const process = Bun.spawn([Bun.env.PYTHON ?? "python3", "-c", code, referenceRoot, input], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  requireValue(status === 0, `Independent reader failed: ${stderr.trim()}`);
  const expected = (JSON.parse(stdout) as typeof actual).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  requireValue(
    JSON.stringify(actual) === JSON.stringify(expected),
    "Independent reader disagrees on payload metadata or bytes",
  );
}

async function main(args: string[]) {
  if (args.includes("--help") || args.length === 0) {
    console.log(
      "Usage: bun tools/resources/validate-car.ts FILE [--strict-associations] [--reference-root game]",
    );
    console.log("Checks car display-resource MR structure. Warnings do not fail; errors exit 1.");
    console.log("Does not establish playable-mod completeness, runtime behavior or art quality.");
    return;
  }
  const input = args.shift()!;
  let referenceRoot: string | undefined;
  const options: CarDisplayOptions = {};
  while (args.length) {
    const option = args.shift();
    if (option === "--strict-associations") options.strictAssociations = true;
    else if (option === "--reference-root") {
      referenceRoot = args.shift();
      requireValue(referenceRoot, "--reference-root requires a path");
    } else throw new Error(`Unknown option: ${option}`);
  }
  const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
  const result = await validateCarMr(bytes, options);
  if (referenceRoot && !result.errors.length) {
    try {
      await independentComparison(bytes, resolve(input), resolve(referenceRoot));
      console.log("PASS: independent game MR reader agrees on every payload.");
    } catch (error) {
      result.errors.push(String(error));
    }
  }
  console.log(
    `${result.errors.length ? "FAIL" : "PASS"}: car display structure — ${result.lods} LODs, ${result.groups} groups, ${result.faces} stored faces, ${result.vertices} vertices, ${result.normals} normals.`,
  );
  console.log(
    `Checked ${result.checkedCorners} frame corners; maximum scratch ${result.maxScratchBytes}/800 bytes.`,
  );
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  for (const warning of result.warnings) console.log(`WARNING: ${warning}`);
  console.log(
    "UNTESTED: runtime registration, physics/collision, engine rendering, VRAM slot relocation and art quality.",
  );
  if (result.errors.length) process.exitCode = 1;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
