import { expect, test } from "bun:test";

import { readMr } from "../../web/src/compatibility/mr.ts";
import type { DiscAssets } from "../../web/src/loader/types.ts";
import { createCarPreview, installCarMods } from "../../web/src/mods/install.ts";
import {
  binary,
  directory,
  stringEntry,
  stringValue,
  writeMr,
} from "../../web/src/mods/mr-writer.ts";
import { packCarMod, readCarMod } from "../../web/src/mods/package.ts";

const manifest = {
  format: "tm4-rewired-mod",
  version: 2,
  kind: "car",
  id: "evelyn",
  name: "Evelyn",
} as const;
async function modelBytes() {
  return new Uint8Array(await Bun.file("mods/evelyn/resources/EVELYN.MR").arrayBuffer());
}
async function packageBytes() {
  return packCarMod(manifest, await modelBytes());
}
async function inheritedPackageBytes() {
  const { root } = await readMr(await modelBytes());
  for (const key of root.files.keys()) if (key !== "machineGuns") root.files.delete(key);
  for (const key of root.folders.keys()) if (key !== "display") root.folders.delete(key);
  root.folders.get("display")!.folders.delete("turbo");
  return packCarMod({ ...manifest, version: 1, base: "thump" }, writeMr(root));
}
function fixture(): DiscAssets {
  const main = directory(),
    objects = directory(),
    car = directory(),
    characters = directory(),
    base = directory();
  main.folders.set("objects", objects);
  objects.folders.set("car", car);
  car.folders.set("characters", characters);
  characters.folders.set("SuperThumper", base);
  base.files.set("filename", stringEntry("thump"));
  const menu = directory(),
    menuRoot = directory(),
    screens = directory(),
    info = directory();
  menu.folders.set("menu", menuRoot);
  menuRoot.folders.set("screens", screens);
  screens.folders.set("thump", info);
  info.files.set("title", stringEntry("Base information"));
  const previews = directory(),
    cars = directory();
  previews.folders.set("menucars", cars);
  cars.files.set("thump", binary(writeMr(directory())));
  const model = directory(),
    display = directory();
  model.folders.set("display", display);
  display.folders.set("resolution", directory());
  model.files.set("physics", binary(new Uint8Array([1, 2, 3, 4])));
  const files = new Map([
    ["/DATA/MAIN.MR", writeMr(main)],
    ["/DATA/MENU.MR", writeMr(menu)],
    ["/DATA/MENU/CHAR.MR", writeMr(previews)],
    ["/DATA/THUMP.MR", writeMr(model)],
  ]);
  files.set(
    "/DATA/files.tsv",
    new TextEncoder().encode(
      [...files].map(([name, data], i) => `${100 + i * 100}\t${data.length}\t${name}`).join("\n") +
        "\n",
    ),
  );
  return {
    files,
    tracks: [],
    leadout: 1000,
    readAudio: () => Promise.resolve(new Uint8Array()),
    readMovie: () => Promise.resolve(new Uint8Array()),
  };
}
test("standalone authored car package round-trips and rejects unsupported capabilities", async () => {
  const bytes = await packageBytes();
  const mod = await readCarMod(bytes);
  expect(mod.manifest).toEqual(manifest);
  expect(mod.model.folders.has("display")).toBe(true);
  await expect(packCarMod({ ...manifest, kind: "map" }, await modelBytes())).rejects.toThrow();
  await expect(packCarMod({ ...manifest, id: "../bad" }, await modelBytes())).rejects.toThrow();
  await expect(
    packCarMod({ ...manifest, callback: "anything" }, await modelBytes()),
  ).rejects.toThrow();
  for (const id of ["with_gap", "abcdefgh"])
    await expect(packCarMod({ ...manifest, id }, await modelBytes())).rejects.toThrow();
  const decoded = (await readMr(await modelBytes())).root;
  decoded.files.set("script", binary(new Uint8Array(4)));
  await expect(packCarMod(manifest, writeMr(decoded))).rejects.toThrow("unsupported resource");
  await expect(readCarMod(bytes.slice(0, -8))).rejects.toThrow();
  await expect(packCarMod({ ...manifest, base: "thump" }, await modelBytes())).rejects.toThrow(
    "Unknown manifest field",
  );
});

test("independent cars reject missing or malformed native resources", async () => {
  const { root } = await readMr(await modelBytes());
  const turbo = root.folders.get("display")!.folders.get("turbo")!;
  const outlet = turbo.folders.get("left")!;
  const originalWidth = outlet.files.get("width")!;
  outlet.files.set("width", { ...originalWidth, bytes: new Uint8Array(4) });
  await expect(packCarMod(manifest, writeMr(root))).rejects.toThrow("width outside");
  outlet.files.set("width", originalWidth);
  const special = root.folders.get("special")!;
  const launch = special.files.get("launchFunc")!;
  special.files.set("launchFunc", stringEntry("CarLaunchThump"));
  await expect(packCarMod(manifest, writeMr(root))).rejects.toThrow(
    "Unsupported independent special",
  );
  special.files.set("launchFunc", launch);
  const near = root.folders.get("display")!.folders.get("resolution")!.folders.get("r0")!;
  const count = near.files.get("NumFaces")!;
  const badCount = count.bytes.slice();
  new DataView(badCount.buffer).setInt32(0, 65536, true);
  near.files.set("NumFaces", { ...count, bytes: badCount });
  await expect(packCarMod(manifest, writeMr(root))).rejects.toThrow("LOD face counts disagree");
  near.files.set("NumFaces", count);
  const sample = root.files.get("engineSample")!;
  const bytes = sample.bytes.slice();
  bytes[1] = 0;
  root.files.set("engineSample", { ...sample, bytes });
  await expect(packCarMod(manifest, writeMr(root))).rejects.toThrow("ADPCM block");
  root.files.delete("engineSample");
  await expect(packCarMod(manifest, writeMr(root))).rejects.toThrow("engineSample");
});
test("independent cars require a complete native Info screen", async () => {
  const { root } = await readMr(await modelBytes());
  const info = root.files.get("info.tim")!;
  root.files.delete("info.tim");
  await expect(packCarMod(manifest, writeMr(root))).rejects.toThrow("info.tim");
  root.files.set("info.tim", { ...info, bytes: info.bytes.slice(0, -4) });
  await expect(packCarMod(manifest, writeMr(root))).rejects.toThrow("Truncated TIM");
  const smaller = info.bytes.slice(0, info.bytes.length - 320 * 2);
  const view = new DataView(smaller.buffer);
  view.setUint32(8, smaller.length - 8, true);
  view.setUint16(18, 239, true);
  root.files.set("info.tim", { ...info, bytes: smaller });
  await expect(packCarMod(manifest, writeMr(root))).rejects.toThrow("320×240 direct-color TIM");
});
test("independent car and preview install without base archives or changes to the package", async () => {
  const assets = fixture(),
    original = assets.files,
    mod = await readCarMod(await packageBytes());
  original.delete("/DATA/THUMP.MR");
  original.delete("/DATA/MENU.MR");
  const before = mod.bytes.slice();
  await installCarMods(assets, [mod]);
  expect(original.has("/DATA/MEVELYN.MR")).toBe(false);
  expect(mod.bytes).toEqual(before);
  const main = (await readMr(assets.files.get("/DATA/MAIN.MR")!)).root;
  const cars = main.folders.get("objects")!.folders.get("car")!.folders.get("characters")!;
  expect(cars.folders.size).toBe(2);
  expect(stringValue(cars.folders.get("Evelyn")!.files.get("filename"))).toBe("mevelyn");
  expect(cars.folders.get("Evelyn")!.files.has("behavior")).toBe(false);
  expect(assets.files.get("/DATA/MENU/MEVELYN.TIM")).toEqual(
    mod.model.files.get("info.tim")!.bytes,
  );
  expect(original.has("/DATA/MENU/MEVELYN.TIM")).toBe(false);
  expect(stringValue(cars.folders.get("SuperThumper")!.files.get("filename"))).toBe("thump");
  const car = (await readMr(assets.files.get("/DATA/MEVELYN.MR")!)).root;
  expect(car.folders.get("physics")!.files.get("maxAxleTorque")!.bytes).toEqual(
    mod.model.folders.get("physics")!.files.get("maxAxleTorque")!.bytes,
  );
  expect(car.files.get("car.vab")!.type).toBe(16);
  expect(stringValue(car.files.get("engineSoundName"))).toBe("mod_evelyn");
  expect(car.files.has("engineSample")).toBe(false);
  expect(car.files.has("info.tim")).toBe(false);
  expect(mod.model.files.has("engineSample")).toBe(true);
  expect(car.folders.get("display")!.folders.has("turbo")).toBe(true);
  const previews = (await readMr(assets.files.get("/DATA/MENU/CHAR.MR")!)).root.folders.get(
    "menucars",
  )!;
  expect(previews.files.has("thump")).toBe(true);
  const preview = (await readMr(previews.files.get("mevelyn")!.bytes)).root;
  expect(preview.folders.get("display")!.folders.has("turbo")).toBe(false);
  expect(preview.files.size).toBe(0);
  const index = new TextDecoder().decode(assets.files.get("/DATA/files.tsv"));
  expect(index).toContain("/DATA/MEVELYN.MR");
  expect(index).toContain("/DATA/MENU/MEVELYN.TIM");
});
test("version 1 retains inherited parameters and reports missing archives atomically", async () => {
  const mod = await readCarMod(await inheritedPackageBytes());
  const assets = fixture(),
    original = assets.files;
  await installCarMods(assets, [mod]);
  const main = (await readMr(assets.files.get("/DATA/MAIN.MR")!)).root;
  const cars = main.folders.get("objects")!.folders.get("car")!.folders.get("characters")!;
  expect(stringValue(cars.folders.get("Evelyn")!.files.get("behavior"))).toBe("thump");
  const car = (await readMr(assets.files.get("/DATA/MEVELYN.MR")!)).root;
  expect(car.files.get("physics")!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  assets.files = original;
  original.delete("/DATA/THUMP.MR");
  await expect(installCarMods(assets, [mod])).rejects.toThrow("Missing mod dependency");
  expect(assets.files).toBe(original);
});

test("conflicting independent mods leave the session unchanged", async () => {
  const assets = fixture(),
    original = assets.files;
  const mod = await readCarMod(await packageBytes());
  await expect(installCarMods(assets, [mod, mod])).rejects.toThrow("conflicts");
  expect(assets.files).toBe(original);
});

test("menu preview bakes each wheel pivot once and leaves the driving geometry unchanged", async () => {
  const mod = await readCarMod(await packageBytes());
  const source = mod.model.folders.get("display")!.folders.get("resolution")!;
  const preview = createCarPreview(mod.model).folders.get("display")!.folders.get("resolution")!;
  const group = source.folders.get("r0")!.folders.get("Groups")!.files.get("fl_wheel")!;
  const originalGroup = new DataView(
    group.bytes.buffer,
    group.bytes.byteOffset,
    group.bytes.byteLength,
  );
  const first = originalGroup.getInt16(4, true);
  const originalBytes = source.files.get("VertexList")!.bytes;
  const original = new DataView(
    originalBytes.buffer,
    originalBytes.byteOffset,
    originalBytes.byteLength,
  );
  const projectedBytes = preview.files.get("VertexList")!.bytes;
  const projected = new DataView(
    projectedBytes.buffer,
    projectedBytes.byteOffset,
    projectedBytes.byteLength,
  );
  for (let axis = 0; axis < 3; ++axis)
    expect(projected.getInt16(first * 8 + axis * 2, true)).toBe(
      original.getInt16(first * 8 + axis * 2, true) + originalGroup.getInt16(24 + axis * 2, true),
    );
  expect(originalGroup.getUint8(30)).toBe(1);
  expect(preview.folders.get("r0")!.folders.get("Groups")!.files.get("fl_wheel")!.bytes[30]).toBe(
    0,
  );
  expect(projectedBytes).not.toBe(originalBytes);
});
