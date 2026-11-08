import { readFile, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

import { json, options, root, run, write } from "../common.js";
import { findDefinitions, planExports, selectExports, validateExports } from "../exports/model.js";
import { renderAccessor, renderRegistry } from "../exports/templates.js";

async function writeJSON(path, value) {
  await write(path, JSON.stringify(value, null, 2) + "\n");
}

async function plan({ gameRoot, sourcesFile, output }) {
  const modules = {};
  for (const path of ["config/game/modules.json", "config/overlays.json"]) {
    const config = await json(join(gameRoot, path));
    for (const [name, info] of Object.entries(config)) {
      modules[info.source ?? name] = Object.values(info.unit_sources ?? {});
    }
  }
  const sources = (await readFile(sourcesFile, "utf8")).split("\n").filter(Boolean);
  const contracts = await json(join(root, "config/exports.json"));
  const manifest = planExports(gameRoot, sources, modules, contracts);
  const rules = manifest.units.map(
    (unit) => `tm4_export_source(${JSON.stringify(unit.source)} "${unit.id}")`,
  );

  await writeJSON(join(output, "manifest.json"), manifest);
  await write(join(output, "sources.cmake"), rules.join("\n") + "\n");
}

async function generate({ manifestFile, unitId, output, compiler }) {
  const manifest = await json(manifestFile);
  const unit = manifest.units.find((unit) => unit.id === unitId);
  if (!unit) throw new Error(`Unknown export unit: ${unitId}`);
  if (!compiler.length) throw new Error("Supply the compiler command after --");

  const astText = await run(
    [
      ...compiler,
      "-fsyntax-only",
      "-Xclang",
      "-ast-dump=json",
      "-MMD",
      "-MF",
      output + ".d",
      "-MT",
      output,
      unit.source,
    ],
    { capture: true },
  );
  const definitions = findDefinitions(JSON.parse(astText));
  const names = selectExports(manifest, unit, definitions);

  await write(output, renderAccessor(unit, names));
  await writeJSON(output.replace(/\.c$/, ".json"), {
    module: unit.module,
    source: unit.source,
    exports: names,
  });
  // A changed header must complete the build step even when exports stay the same.
  await utimes(output, new Date(), new Date());
}

async function check({ manifestFile, stamp }) {
  const manifest = await json(manifestFile);
  const directory = dirname(manifestFile);
  const entries = await Promise.all(
    manifest.units.map(async (unit) => {
      const result = await json(join(directory, unit.id + ".json"));
      return [unit.id, result];
    }),
  );
  const result = validateExports(manifest, new Map(entries));
  await write(join(directory, "registry.c"), renderRegistry(manifest, result));
  await write(stamp, "All required overlay exports have native definitions.\n");
  console.log(`Checked native exports for ${Object.keys(manifest.modules).length} modules`);
}

const [action, ...args] = process.argv.slice(2);
const separator = args.indexOf("--");
const compiler = separator < 0 ? [] : args.slice(separator + 1);
const commandArgs = separator < 0 ? args : args.slice(0, separator);
const flags = options(["sources", "output", "game-root", "manifest", "unit", "stamp"], commandArgs);

switch (action) {
  case "plan":
    await plan({ gameRoot: flags["game-root"], sourcesFile: flags.sources, output: flags.output });
    break;
  case "generate":
    await generate({
      manifestFile: flags.manifest,
      unitId: flags.unit,
      output: flags.output,
      compiler,
    });
    break;
  case "check":
    await check({ manifestFile: flags.manifest, stamp: flags.stamp });
    break;
  default:
    throw new Error(`Unknown export command: ${action}`);
}
