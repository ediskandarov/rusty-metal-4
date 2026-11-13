import { expect, test } from "bun:test";

import { directory } from "@tm4/resources/mods/mr-writer";
import { type CarMod, maxCarMods, packCarMod, readCarMod } from "@tm4/resources/mods/package";

import { createModsStore, modsLocked, modsNeedRestart } from "../../apps/player/src/state/mods.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const manifest = {
  format: "tm4-rewired-mod",
  version: 2,
  kind: "car",
  id: "evelyn",
  name: "Evelyn",
} as const;
const bytes = new Uint8Array([1]);
const file = (data = bytes, name = "car.tm4mod") => new File([data], name);
const read = (data: Uint8Array<ArrayBuffer>): Promise<CarMod> =>
  Promise.resolve({
    manifest,
    bytes: data,
    model: directory(),
    warnings: [],
  });
const save = () => Promise.resolve();
async function ready(store: ReturnType<typeof createModsStore>) {
  await store.getState().beginSession();
  store.getState().finishStartup(false);
}

test("startup waits for restore and locks edits before awaiting it", async () => {
  const restored = deferred<Uint8Array<ArrayBuffer>[]>();
  const store = createModsStore({ load: () => restored.promise, save, read });
  expect(modsLocked(store.getState())).toBe(true);
  const session = store.getState().beginSession();
  await store.getState().addFiles([file(new Uint8Array([2]))]);
  restored.resolve([bytes]);
  const selected = await session;
  expect(selected[0]!.bytes).toEqual(bytes);
  expect(modsLocked(store.getState())).toBe(true);
  selected.pop();
  expect(store.getState().active).toHaveLength(1);
  store.getState().finishStartup(true);
  expect(modsLocked(store.getState())).toBe(false);
});

test("launch includes an in-flight save, which cannot unlock startup", async () => {
  const saved = deferred<void>();
  const store = createModsStore({
    load: () => Promise.resolve([]),
    save: () => saved.promise,
    read,
  });
  await ready(store);
  const adding = store.getState().addFiles([file()]);
  const session = store.getState().beginSession();
  expect(store.getState().selected).toHaveLength(0);
  saved.resolve();
  await adding;
  expect((await session)[0]!.bytes).toEqual(bytes);
  expect(modsLocked(store.getState())).toBe(true);
  await store.getState().remove("evelyn");
  expect(store.getState().selected).toHaveLength(1);
  store.getState().finishStartup(true);
  expect(modsNeedRestart(store.getState())).toBe(false);
});

test("selected packages can change without altering the active session", async () => {
  const store = createModsStore({ load: () => Promise.resolve([bytes]), save, read });
  await store.getState().beginSession();
  store.getState().finishStartup(true);
  const active = store.getState().active;
  await store.getState().addFiles([file()]);
  expect(modsNeedRestart(store.getState())).toBe(false);
  await store.getState().addFiles([file(new Uint8Array([2]))]);
  expect(modsNeedRestart(store.getState())).toBe(true);
  expect(store.getState().active).toBe(active);
  expect(active[0]!.bytes).toEqual(bytes);
  await store.getState().remove("evelyn");
  expect(store.getState().selected).toHaveLength(0);
  expect(modsNeedRestart(store.getState())).toBe(true);
  await store.getState().addFiles([file()]);
  expect(modsNeedRestart(store.getState())).toBe(false);
});

test("failed save preserves selected and active packages and permits retry", async () => {
  let fail = true;
  const store = createModsStore({
    load: () => Promise.resolve([bytes]),
    read,
    save: () => (fail ? Promise.reject(new Error("Storage full")) : Promise.resolve()),
  });
  await store.getState().beginSession();
  store.getState().finishStartup(true);
  const selected = store.getState().selected;
  await store.getState().remove("evelyn");
  expect(store.getState().selected).toBe(selected);
  expect(store.getState().error).toBe("Storage full");
  expect(modsNeedRestart(store.getState())).toBe(false);
  expect(modsLocked(store.getState())).toBe(false);
  fail = false;
  await store.getState().remove("evelyn");
  expect(store.getState().error).toBeNull();
  expect(modsNeedRestart(store.getState())).toBe(true);
});

test("restore errors remain visible and failed game startup releases the session", async () => {
  const store = createModsStore({
    load: () => Promise.reject(new Error("Storage unavailable")),
    save,
    read,
  });
  expect(await store.getState().beginSession()).toEqual([]);
  store.getState().finishStartup(false);
  expect(store.getState().error).toContain("Storage unavailable");
  expect(modsLocked(store.getState())).toBe(false);
  await store.getState().addFiles([file()]);
  expect(store.getState().error).toBeNull();
  expect(await store.getState().beginSession()).toHaveLength(1);
  store.getState().finishStartup(false);
  expect(store.getState().active).toHaveLength(0);
  expect(store.getState().selected).toHaveLength(1);
});

test("invalid batches never partially replace the selection", async () => {
  let saves = 0;
  const store = createModsStore({
    load: () => Promise.resolve([bytes]),
    read,
    save: () => {
      ++saves;
      return Promise.resolve();
    },
  });
  await ready(store);
  const selected = store.getState().selected;
  await store.getState().addFiles([file(new Uint8Array([2])), file(bytes, "bad.bin")]);
  expect(store.getState().error).toContain("choose a .tm4mod");
  expect(store.getState().selected).toBe(selected);
  expect(saves).toBe(0);
});

test("conflicting names and oversized selections are rejected before persistence", async () => {
  let saves = 0;
  const store = createModsStore({
    load: () => Promise.resolve([]),
    save: () => {
      ++saves;
      return Promise.resolve();
    },
    read: async (data) => ({
      ...(await read(data)),
      manifest: { ...manifest, id: `car${data[0]}` },
    }),
  });
  await ready(store);
  await store.getState().addFiles([file(new Uint8Array([1])), file(new Uint8Array([2]))]);
  expect(store.getState().error).toBe("Two mods use the same car name");
  await store
    .getState()
    .addFiles(Array.from({ length: maxCarMods + 1 }, (_, i) => file(new Uint8Array([i]))));
  expect(store.getState().error).toContain(`At most ${maxCarMods}`);
  expect(store.getState().selected).toHaveLength(0);
  expect(saves).toBe(0);
});

test("real mod package is validated, persisted and restored through the store", async () => {
  const model = new Uint8Array(await Bun.file("mods/evelyn/resources/EVELYN.MR").arrayBuffer());
  const packed = await packCarMod(manifest, model);
  let saved: Uint8Array<ArrayBuffer>[] = [];
  const store = createModsStore({
    load: () => Promise.resolve([]),
    read: readCarMod,
    save: (mods) => {
      saved = mods.map((mod) => mod.bytes);
      return Promise.resolve();
    },
  });
  await ready(store);
  await store.getState().addFiles([file(packed)]);
  expect(store.getState().error).toBeNull();
  expect(saved).toHaveLength(1);
  const restored = createModsStore({ load: () => Promise.resolve(saved), save });
  const selected = await restored.getState().beginSession();
  expect(selected[0]!.manifest).toEqual(manifest);
  expect(selected[0]!.model.folders.has("display")).toBe(true);
});
