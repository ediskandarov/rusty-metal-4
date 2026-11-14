import { utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { runCli, UsageError } from "../cli.js";
import { json, root, write } from "../common.js";
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
  const sources = (await Bun.file(sourcesFile).text()).split("\n").filter(Boolean);
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

  const astText =
    await $`${compiler} -fsyntax-only -Xclang -ast-dump=json -MMD -MF ${output + ".d"} -MT ${output} ${unit.source} 2> ${Bun.stderr}`
      .cwd(root)
      .text();
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

await runCli(async () => {
  const {
    values: flags,
    positionals,
    tokens,
  } = parseArgs({
    strict: true,
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: "boolean", short: "h" },
      sources: { type: "string" },
      output: { type: "string" },
      "game-root": { type: "string" },
      manifest: { type: "string" },
      unit: { type: "string" },
      stamp: { type: "string" },
    },
  });
  if (flags.help) {
    console.log(
      "Usage: bun tools/prepare/exports.js plan --game-root PATH --sources FILE --output PATH\n       bun tools/prepare/exports.js generate --manifest FILE --unit ID --output FILE -- COMPILER [ARGS...]\n       bun tools/prepare/exports.js check --manifest FILE --stamp FILE",
    );
    return;
  }
  const separator = tokens.find((token) => token.kind === "option-terminator");
  const before = tokens.filter(
    (token) => token.kind === "positional" && (!separator || token.index < separator.index),
  );
  if (before.length !== 1)
    throw new UsageError("Supply one export command: plan, generate or check");
  const [action, ...compiler] = positionals;
  if (action !== "generate" && separator)
    throw new UsageError("Only generate accepts a compiler after --");
  const requirements = {
    plan: ["game-root", "sources", "output"],
    generate: ["manifest", "unit", "output"],
    check: ["manifest", "stamp"],
  };
  if (!Object.hasOwn(requirements, action))
    throw new UsageError("Unknown export command: " + action);
  const required = requirements[action];
  for (const name of required) if (!flags[name]) throw new UsageError("Supply --" + name);
  if (action === "generate" && !compiler.length)
    throw new UsageError("Supply the compiler command after --");

  switch (action) {
    case "plan":
      await plan({
        gameRoot: flags["game-root"],
        sourcesFile: flags.sources,
        output: flags.output,
      });
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
});
