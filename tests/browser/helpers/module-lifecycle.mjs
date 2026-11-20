/* global HEAPU8, getWasmTableEntry, _free */
import assert from "node:assert/strict";

import { $ } from "bun";

import { nameModule } from "../../../packages/resources/src/mods/modules.ts";
import { binary, directory, writeMr } from "../../../packages/resources/src/mods/mr-writer.ts";

export async function moduleProbe(output) {
  const path = output + ".probe.wasm";
  await $`emcc tests/native/module_probe.c -O2 -pthread -sSIDE_MODULE=2 -sASYNCIFY=0 -sEXPORTED_FUNCTIONS=_Tm4ModuleExport -o ${path}`;
  const wasm = nameModule(new Uint8Array(await Bun.file(path).arrayBuffer()), "mprobe.sym");
  const root = directory();
  root.files.set("behavior.mod", { ...binary(wasm), type: 6 });
  return [...writeMr(root)];
}
export async function checkModuleLifecycle(page, archive) {
  const result = await page.evaluate(async (bytes) => {
    const { Module } = globalThis;
    const pointer = Module._malloc(bytes.length);
    HEAPU8.set(bytes, pointer);
    const load = (registration) =>
      Module.ccall(
        "RegAddReg",
        "number",
        ["string", "number", "string"],
        ["/", pointer, registration],
        { async: true },
      );
    const unload = (registration) =>
      Module.ccall("RegRemoveReg", null, ["string"], [registration], { async: true });
    const symbol = () =>
      Module.ccall(
        "WebDynamicModuleExport",
        "number",
        ["string", "string"],
        ["mprobe.sym", "ProbeValue"],
      );
    const loaded = () =>
      Module.ccall("WebNativeModuleLoaded", "number", ["string"], ["mprobe.sym"]);
    try {
      if (!(await load("probe-a")) || !(await load("probe-b")))
        throw Error("MR registration failed");
      const value = getWasmTableEntry(symbol())();
      await unload("probe-a");
      const shared = loaded();
      if (!symbol()) throw Error("First owner unloaded shared module");
      await unload("probe-b");
      const removed = [loaded(), symbol()];
      if (!(await load("probe-c"))) throw Error("Module reload failed");
      const again = getWasmTableEntry(symbol())();
      await unload("probe-c");
      return { value, shared, removed, again };
    } finally {
      _free(pointer);
    }
  }, archive);
  assert.deepEqual(result, { value: 37, shared: 1, removed: [0, 0], again: 37 });
}
