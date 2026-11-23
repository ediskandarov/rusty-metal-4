import { expect, test } from "bun:test";

import { maxModBytes, type ModDraft, packMod, readMod, resolveMods } from "@tm4/mods";
import { assembleMods } from "@tm4/mods/assembly";
import { readMr } from "@tm4/resources/compatibility/mr";
import type { DiscAssets } from "@tm4/resources/loader/types";
import { directory, stringEntry, writeMr } from "@tm4/resources/mods/mr-writer";
import { unzipSync, zipSync } from "fflate";

function draft(id: string): ModDraft {
  const source = "files/example.MR";
  const resource = directory();
  resource.files.set("filename", stringEntry("example"));
  return {
    plan: {
      format: "rm4-mod/1",
      id,
      name: id,
      version: "1",
      requires: [],
      base: [],
      contents: [{ id: `${id}:car:example`, name: "Example", kind: "car" }],
      mounts: [],
      registry: [
        {
          archive: "/DATA/MAIN.MR",
          folder: ["mod"],
          name: id,
          source,
          kind: "folder",
        },
      ],
    },
    files: new Map([[source, writeMr(resource)]]),
  };
}

test("release identity survives ZIP repacking but rejects changed payloads", async () => {
  const bytes = await packMod(draft("example"));
  const original = await readMod(bytes);
  const files = unzipSync(bytes);
  const repacked = zipSync(files, { level: 0, mtime: new Date(2001, 0, 1) });
  expect((await readMod(repacked)).digest).toBe(original.digest);
  files["files/example.MR"]![0] = 0;
  await expect(readMod(zipSync(files, { level: 0 }))).rejects.toThrow("verification failed");
  await expect(readMod(zipSync(files, { level: 6 }))).rejects.toThrow("uncompressed");
  await expect(readMod(bytes.subarray(0, 21))).rejects.toThrow("archive size");
  expect(bytes.length).toBeLessThan(maxModBytes);
});

test("the session pins exact dependencies and detects conflicting registry entries", async () => {
  const dependency = await readMod(await packMod(draft("depends-on")));
  const root = draft("root");
  root.plan.requires = [{ id: dependency.manifest.id, digest: dependency.digest }];
  const release = await readMod(await packMod(root));
  expect(resolveMods([release, dependency], [release.digest])).toEqual([dependency, release]);
  expect(() => resolveMods([release], [release.digest])).toThrow("requires depends-on");
  const conflict = draft("conflicting");
  conflict.plan.registry[0]!.name = "ROOT";
  const other = await readMod(await packMod(conflict));
  expect(() => resolveMods([release, other, dependency], [release.digest, other.digest])).toThrow(
    "Duplicate mod registry entry",
  );
});

test("resource assembly is atomic when a registry binding conflicts with the disc", async () => {
  const assets: DiscAssets = {
    files: new Map([
      ["/DATA/MAIN.MR", writeMr(directory())],
      ["/DATA/files.tsv", new TextEncoder().encode("1\t16\t/DATA/MAIN.MR\n")],
    ]),
    tracks: [],
    leadout: 0,
    readAudio: () => Promise.resolve(new Uint8Array()),
    readMovie: () => Promise.resolve(new Uint8Array()),
  };
  const release = await readMod(await packMod(draft("example")));
  const original = assets.files;
  await assembleMods(assets, [release], "");
  expect(assets.files).not.toBe(original);
  expect(
    (await readMr(assets.files.get("/DATA/MAIN.MR")!)).root.folders
      .get("mod")
      ?.folders.has("example"),
  ).toBe(true);
  const active = assets.files;
  await expect(assembleMods(assets, [release], "")).rejects.toThrow("already exists");
  expect(assets.files).toBe(active);
});

test("registry keys for cars and maps fit in the engine's save fields", async () => {
  const car = draft("car");
  car.plan.registry[0]!.folder = ["objects", "car", "characters"];
  car.plan.registry[0]!.name = "TM3 Sweet Tooth";
  await expect(packMod(car)).rejects.toThrow("Car registry key exceeds 11 bytes");
  car.plan.registry[0]!.name = "mtm3sw";
  expect((await readMod(await packMod(car))).manifest.registry[0]?.name).toBe("mtm3sw");

  const map = draft("map");
  map.plan.registry[0]!.folder = ["worlds"];
  map.plan.registry[0]!.name = "A very long map name";
  await expect(packMod(map)).rejects.toThrow("Map registry key exceeds 19 bytes");
});
