import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTimLayout, sha256 } from "@tm4/resources/compatibility";
import {
  discDirectorySources,
  type DiscFileReference,
  inspectDisc,
} from "@tm4/resources/host/disc";
import {
  generateResourceReference,
  prepareResources,
  writeResourceFiles,
} from "@tm4/resources/host/resources";
import { discoverResources } from "@tm4/resources/loader/resources";
import type { DiscReference } from "@tm4/resources/loader/types";

const temporary: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "tm4-resources-"));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function record(name: string, lba: number, size: number, folder = false) {
  const bytes = new Uint8Array((33 + name.length + 1) & ~1);
  const view = new DataView(bytes.buffer);
  bytes[0] = bytes.length;
  view.setUint32(2, lba, true);
  view.setUint32(6, lba);
  view.setUint32(10, size, true);
  view.setUint32(14, size);
  bytes[25] = folder ? 2 : 0;
  bytes[32] = name.length;
  bytes.set(new TextEncoder().encode(name), 33);
  return bytes;
}

// Source-free ISO fixture with a TIM, opaque sound, raw movie and separate audio.
async function discFixture() {
  const root = await directory();
  const image = new Uint8Array(23 * 2352);
  for (let i = 0; i < 23; i++) {
    const sector = image.subarray(i * 2352, (i + 1) * 2352);
    sector.fill(255, 1, 11);
    sector[15] = 2;
  }
  const sector = (i: number) => image.subarray(i * 2352 + 24, i * 2352 + 24 + 2048);
  sector(16).set(new TextEncoder().encode("\x01CD001\x01"));
  sector(16).set(record("\0", 17, 2048, true), 156);
  const data = record("DATA", 18, 2048, true);
  sector(17).set(data);
  sector(17).set(record("SCUS_945.60;1", 19, 2048), data.length);
  const tim = new Uint8Array(24);
  const view = new DataView(tim.buffer);
  view.setUint32(0, 0x10, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 16, true);
  view.setUint16(16, 2, true);
  view.setUint16(18, 1, true);
  let at = 0;
  for (const entry of [
    record("A.TIM;1", 20, tim.length),
    record("CLIP.STR;1", 21, 2048),
    record("SOUND.VAB;1", 22, 3),
  ]) {
    sector(18).set(entry, at);
    at += entry.length;
  }
  const exe = new Uint8Array(2048);
  exe.set(new TextEncoder().encode("PS-X EXE"));
  sector(19).set(exe);
  sector(20).set(tim);
  sector(21).fill(42);
  const sound = new Uint8Array([1, 2, 3]);
  sector(22).set(sound);
  const audio = new Uint8Array(2 * 2352).fill(5);
  const cue = new TextEncoder().encode(
    'FILE "disc.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00\nFILE "audio.bin" BINARY\n TRACK 02 AUDIO\n INDEX 01 00:00:00\n',
  );
  const contents = new Map([
    ["disc.bin", image],
    ["audio.bin", audio],
    ["disc.cue", cue],
  ]);
  for (const [name, bytes] of contents) await writeFile(join(root, name), bytes);
  const reference = {
    executable: { name: "SCUS_945.60", sha256: await sha256(exe) },
    tracks: [
      { number: 1, audio: false, file: "disc.bin", index: 0, size: image.length },
      { number: 2, audio: true, file: "audio.bin", index: 0, size: audio.length },
    ],
    files: await Promise.all(
      [...contents].map(async ([name, bytes]) => ({
        name,
        size: bytes.length,
        sha256: await sha256(bytes),
      })),
    ),
  } satisfies DiscReference & DiscFileReference;
  return { root, reference, image, exe, tim, sound, audio };
}

test("host directory sources filter supported files and preserve bounded, abortable reads", async () => {
  const root = await directory();
  await writeFile(join(root, "data.IMG"), new Uint8Array([1, 2, 3, 4]));
  await writeFile(join(root, "disc.CCD"), "descriptor");
  await writeFile(join(root, "disc.SUB"), "subchannel");
  await writeFile(join(root, "cover.png"), "ignored");
  const sources = await discDirectorySources(root);
  expect([...sources.keys()]).toEqual(["data.img", "disc.ccd", "disc.sub"]);
  const source = sources.get("data.img")!;
  expect(await source.read(1, 2)).toEqual(new Uint8Array([2, 3]));
  expect(await source.read(4, 0)).toHaveLength(0);
  await expect(source.read(3, 2)).rejects.toThrow("outside disc file");
  const controller = new AbortController();
  controller.abort();
  await expect(source.read(0, 1, { signal: controller.signal })).rejects.toThrow();
});

test("host directory sources reject symlinks escaping the selected directory", async () => {
  const root = await directory();
  const outside = await directory();
  await writeFile(join(outside, "data.bin"), "private");
  await symlink(join(outside, "data.bin"), join(root, "data.bin"));
  await expect(discDirectorySources(root)).rejects.toThrow("escapes its directory");
});

test("host inspection reports identity warnings without rejecting modified or missing tracks", async () => {
  const { root, reference } = await discFixture();
  const original = await inspectDisc(root, reference);
  expect(original.warnings).toEqual([]);
  expect(original.files.every((file) => file.matchesReference)).toBe(true);
  expect(original.files.find((file) => file.name === "disc.bin")!.file.size).toBe(23 * 2352);
  await writeFile(join(root, "audio.bin"), new Uint8Array(2 * 2352));
  expect((await inspectDisc(root, reference)).warnings.join("\n")).toContain(
    "Modified or unrecognized",
  );
  await rm(join(root, "audio.bin"));
  expect((await inspectDisc(root, reference)).warnings).toEqual(["Missing disc file: audio.bin"]);
  await expect(generateResourceReference(root, reference)).rejects.toThrow(
    "Missing original track",
  );
});

test("strict reference generation records logical resources, raw movies, audio and TIM layout", async () => {
  const { root, reference, image, tim, sound, audio } = await discFixture();
  const result = await generateResourceReference(root, reference);
  expect(result.files).toEqual([
    { id: "/DATA/A.TIM", size: tim.length, sha256: await sha256(tim), tim: readTimLayout(tim) },
    { id: "/DATA/CLIP.STR", size: 2048, sha256: await sha256(image.slice(21 * 2352, 22 * 2352)) },
    { id: "/DATA/SOUND.VAB", size: sound.length, sha256: await sha256(sound) },
    { id: "AUDIO/02", size: audio.length, sha256: await sha256(audio) },
  ]);
  expect(JSON.stringify(result)).not.toContain(root);
  await expect(
    generateResourceReference(root, {
      ...reference,
      executable: { ...reference.executable, sha256: "0".repeat(64) },
    }),
  ).rejects.toThrow("Original executable checksum mismatch");
});

test("strict reference generation rejects a modified dump even when the executable is stock", async () => {
  const { root, reference, image } = await discFixture();
  image[22 * 2352 + 24] = 99;
  await writeFile(join(root, "disc.bin"), image);
  await expect(generateResourceReference(root, reference)).rejects.toThrow(
    "Modified reference track: disc.bin",
  );
});

test("headless preparation reuses compatibility checks and writes only runtime resource files", async () => {
  const { root, reference, exe, tim, sound, image } = await discFixture();
  const destination = await directory();
  const stock = await generateResourceReference(root, reference);
  image[22 * 2352 + 24] = 99;
  await writeFile(join(root, "disc.bin"), image);
  const warnings: string[] = [];
  const count = await prepareResources(root, destination, {
    discReference: reference,
    resourceReference: [
      { id: "/SCUS_945.60", size: exe.length, sha256: await sha256(exe) },
      ...stock.files,
    ],
    warn: (message) => warnings.push(message),
  });
  expect(count).toBe(3);
  expect(new Uint8Array(await readFile(join(destination, "DATA/A.TIM")))).toEqual(tim);
  expect(new Uint8Array(await readFile(join(destination, "DATA/SOUND.VAB")))).toEqual(
    new Uint8Array([99, ...sound.slice(1)]),
  );
  expect(await Bun.file(join(destination, "SCUS_945.60")).exists()).toBe(false);
  expect(await Bun.file(join(destination, "DATA/CLIP.STR")).exists()).toBe(false);
  expect(await Bun.file(join(destination, "DATA/files.tsv")).text()).toBe(
    "20\t24\t/DATA/A.TIM\n22\t3\t/DATA/SOUND.VAB\n",
  );
  expect(warnings.join("\n")).toContain("/DATA/SOUND.VAB");
  const { resources } = await discoverResources(
    await discDirectorySources(root),
    new AbortController().signal,
    reference,
  );
  expect(resources.map((resource) => resource.id)).toContain("AUDIO/02");
});

test("resource export rejects parent traversal and takes its output destination explicitly", async () => {
  const destination = await directory();
  const bytes = new Uint8Array([1, 2, 3]);
  await writeResourceFiles(new Map([["/DATA/a.bin", bytes]]), destination);
  expect(new Uint8Array(await readFile(join(destination, "DATA/a.bin")))).toEqual(bytes);
  await expect(
    writeResourceFiles(new Map([["/../escape.bin", bytes]]), destination),
  ).rejects.toThrow("escapes its destination");
});
