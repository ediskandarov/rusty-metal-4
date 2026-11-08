import { expect, test } from "bun:test";

import {
  findDefinitions,
  planExports,
  selectExports,
  validateExports,
} from "../../tools/exports/model.js";
import { renderAccessor, renderRegistry } from "../../tools/exports/templates.js";

function fixture(required, definitions) {
  const modules = {};
  for (const [name, exports] of Object.entries(required))
    modules[name] = { exports, image_name: `${name}.sym` };
  const units = definitions.map(([module], index) => ({
    id: `Unit${index}`,
    module,
    modules: [module],
    source: `unit${index}.c`,
  }));
  const results = new Map(definitions.map(([, exports], index) => [`Unit${index}`, { exports }]));
  return { manifest: { modules, units }, results };
}

test("AST selection includes definitions, not declarations or locals", async () => {
  const compiler = Bun.spawn(
    ["clang", "-x", "c", "-fsyntax-only", "-Xclang", "-ast-dump=json", "-"],
    {
      stdin: new Blob([
        `extern int declaration; int prototype(int); int data[3];
      static int private_data; int function(int argument) { int local; return argument; }`,
      ]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const ast = await new Response(compiler.stdout).json();
  expect(await compiler.exited).toBe(0);
  expect([...findDefinitions(ast)].sort()).toEqual(["data", "function", "private_data"]);
});

test("omitted modules fail before generation", () => {
  expect(() =>
    planExports("/game", ["/game/src/modules/car/car.c"], { car: [], conveyer: [] }, {}),
  ).toThrow("Modules missing from native build: conveyer");
});

test("missing, duplicate and unreviewed colliding exports fail", () => {
  const missing = fixture({ weapon: ["Launch", "Sizeof"] }, [["weapon", ["Sizeof"]]]);
  expect(() => validateExports(missing.manifest, missing.results)).toThrow(
    "Missing native exports",
  );
  const duplicate = fixture({ weapon: ["Launch"] }, [
    ["weapon", ["Launch"]],
    ["weapon", ["Launch"]],
  ]);
  expect(() => validateExports(duplicate.manifest, duplicate.results)).toThrow(
    "Duplicate native definition",
  );
  const collision = fixture({ weapon: ["Launch"], car: ["Launch"] }, [
    ["weapon", ["Launch"]],
    ["car", ["Launch"]],
  ]);
  expect(() => validateExports(collision.manifest, collision.results)).toThrow(
    "Unresolved cross-module",
  );
});

test("shared definitions satisfy both images; empty units are omitted", () => {
  const { manifest, results } = fixture({ neon: ["Pathing"], oil: ["Pathing"] }, [
    ["neon", ["Pathing"]],
    ["oil", []],
  ]);
  manifest.units[0].modules = ["neon", "oil"];
  const registry = renderRegistry(manifest, validateExports(manifest, results));
  expect(registry).toContain('!strcasecmp(module, "neon") || !strcasecmp(module, "oil")');
  expect(registry).toContain(
    'WebNativeModuleLoaded("neon.sym") || WebNativeModuleLoaded("oil.sym")',
  );
  expect(registry).not.toContain("Unit1");
});

test("tread exports require module-qualified lookup", () => {
  const { manifest, results } = fixture(
    { "cars/c_tank": ["TreadPolysProcess"], "cars/c_minion": ["TreadPolysProcess"] },
    [
      ["cars/c_tank", ["TreadPolysProcess"]],
      ["cars/c_minion", ["TreadPolysProcess"]],
    ],
  );
  const registry = renderRegistry(manifest, validateExports(manifest, results));
  expect(registry).toContain('if (!strcasecmp(name, "treadpolysprocess"))\n        return 0;');
});

test("menu aliases and browser-owned loops remain explicit", () => {
  const { manifest, results } = fixture({ menu: ["CarRelocateBitStuff", "MenuMain", "MenuSave"] }, [
    ["menu", ["CarRelocateBitStuff"]],
  ]);
  expect(() => validateExports(manifest, results)).not.toThrow();
  const names = selectExports(
    manifest,
    manifest.units[0],
    new Set(["MenuRelocateCarTextures", "MenuMain"]),
  );
  expect(names).toEqual(["CarRelocateBitStuff"]);
  expect(renderAccessor(manifest.units[0], names)).toContain("&MenuRelocateCarTextures;");
});
