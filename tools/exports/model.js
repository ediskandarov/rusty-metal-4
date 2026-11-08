import { dirname, relative } from "node:path";

const treadModules = ["cars/c_tank", "cars/c_minion", "cars/c_crush"];
const treadExports = [
  "TreadPolysClassConstructor",
  "TreadPolysClassDestructor",
  "TreadPolysConstructor",
  "TreadPolysDestructor",
  "TreadPolysProcess",
];

// These two PS1 blocking loops are driven by bootstrap.c in the browser.
const unavailableExports = { menu: ["MenuMain", "MenuSave"] };

export function nativeName(module, exportName) {
  if (module === "menu" && exportName === "CarRelocateBitStuff") {
    return "MenuRelocateCarTextures";
  }
  if (treadModules.includes(module) && treadExports.includes(exportName)) {
    return `Web_${module.replaceAll("/", "_")}_${exportName}`;
  }
  return exportName;
}

export function planExports(gameRoot, sources, modules, contracts) {
  const sourceRoot = `${gameRoot}/src/modules`;
  const selectedModules = new Set();
  for (const source of sources) {
    const module = relative(sourceRoot, dirname(source));
    if (module in modules) selectedModules.add(module);
  }

  const missing = Object.keys(modules).filter((module) => !selectedModules.has(module));
  if (missing.length) {
    throw new Error(`Modules missing from native build: ${missing.join(", ")}`);
  }

  const units = [];
  for (const source of sources) {
    const sourcePath = relative(sourceRoot, source);
    const module = dirname(sourcePath);
    let owners;
    if (module in modules) {
      owners = [module];
    } else {
      const gamePath = relative(gameRoot, source);
      owners = [...selectedModules].filter((name) => modules[name].includes(gamePath)).sort();
    }
    if (!owners.length) throw new Error(`No module for ${source}`);
    for (const owner of owners) {
      if (!contracts[owner]) throw new Error(`No export contract for ${owner}`);
    }
    units.push({
      source,
      module: owners[0],
      modules: owners,
      id: "WebExports_" + sourcePath.replace(/\.c$/, "").replace(/[^a-zA-Z0-9_]/g, "_"),
    });
  }

  const selectedContracts = {};
  for (const module of selectedModules) selectedContracts[module] = contracts[module];
  return { modules: selectedContracts, units };
}

export function findDefinitions(ast) {
  const names = new Set();
  for (const node of ast.inner ?? []) {
    if (node.kind === "FunctionDecl") {
      const hasBody = node.inner?.some((child) => child.kind === "CompoundStmt");
      if (hasBody) names.add(node.name);
    } else if (node.kind === "VarDecl") {
      if (node.storageClass !== "extern" || "init" in node) names.add(node.name);
    }
  }
  return names;
}

export function selectExports(manifest, unit, definitions) {
  const names = new Set();
  const unavailable = unavailableExports[unit.module] ?? [];
  for (const module of unit.modules) {
    for (const name of manifest.modules[module].exports) {
      if (!unavailable.includes(name) && definitions.has(nativeName(unit.module, name))) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

function isReviewedCollision(name, modules) {
  if (name === "carrelocatebitstuff") {
    return modules.length === 2 && modules.includes("car") && modules.includes("menu");
  }
  const isTreadExport = treadExports.some((exportName) => exportName.toLowerCase() === name);
  return isTreadExport && modules.every((module) => treadModules.includes(module));
}

export function validateExports(manifest, results) {
  const found = new Map();
  for (const module of Object.keys(manifest.modules)) found.set(module, new Set());
  const owners = new Map();
  const activeUnits = [];

  for (const unit of manifest.units) {
    const result = results.get(unit.id);
    if (!result) throw new Error(`Missing compiler result: ${unit.id}`);
    if (result.exports.length) activeUnits.push(unit);

    for (const name of result.exports) {
      const key = name.toLowerCase();
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push(unit.module);
    }
    for (const module of unit.modules) {
      const required = manifest.modules[module].exports;
      const definitions = found.get(module);
      for (const name of result.exports) {
        if (!required.includes(name)) continue;
        if (definitions.has(name))
          throw new Error(`Duplicate native definition: ${module}:${name}`);
        definitions.add(name);
      }
    }
  }

  for (const [module, contract] of Object.entries(manifest.modules)) {
    const unavailable = unavailableExports[module] ?? [];
    const missing = contract.exports.filter(
      (name) => !found.get(module).has(name) && !unavailable.includes(name),
    );
    if (missing.length) throw new Error(`Missing native exports: ${module}: ${missing.join(", ")}`);
  }

  const collisions = [];
  for (const [name, modules] of owners) {
    if (modules.length < 2) continue;
    if (!isReviewedCollision(name, modules)) {
      throw new Error(`Unresolved cross-module export: ${name}: ${modules.join(", ")}`);
    }
    collisions.push(name);
  }
  return { activeUnits, collisions: collisions.sort() };
}
