import { expect, test } from "bun:test";

import reference from "../../config/disc.json";
import { byteRange, serveFile } from "../../tools/server/files.js";
import { discTracks, parseCue } from "../../web/src/loader/cue.ts";
import { Disc } from "../../web/src/loader/disc.ts";
import { checkRange, directorySources, localSources } from "../../web/src/loader/sources.ts";
import { sha256, verifyExecutable } from "../../web/src/loader/verify.ts";

const cue =
  'FILE "data.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00\nFILE "audio.bin" BINARY\n TRACK 02 AUDIO\n INDEX 01 00:02:00\n';

test("CUE rejects invalid timing, paths and missing indexes", () => {
  expect(parseCue(cue)[1]?.index).toBe(150);
  expect(() => parseCue(cue.replace("00:02:00", "00:60:00"))).toThrow("Invalid CUE INDEX");
  expect(() => parseCue(cue.replace("data.bin", "../data.bin"))).toThrow("Invalid disc file name");
  expect(() => parseCue(cue.replace(" INDEX 01 00:00:00\n", ""))).toThrow("INDEX 01");
});

test("missing optional audio preserves original disc TOC", async () => {
  const warnings: string[] = [];
  const data = reference.tracks[0]!;
  const sources = new Map([
    [
      "data.bin",
      { name: "data.bin", size: data.size, read: () => Promise.resolve(new Uint8Array()) },
    ],
  ]);
  const result = await discTracks(sources, reference, (message) => warnings.push(message));
  expect(result.tracks).toHaveLength(23);
  expect(result.tracks[1]?.start).toBe(163527);
  expect(result.tracks[1]?.toc).toBe(163650);
  expect(warnings.length).toBe(23);
});

test("file reads are bounded and duplicate filenames fail", async () => {
  const file = new File([new Uint8Array([1, 2, 3])], "data.bin");
  const source = localSources([file]).get("data.bin")!;
  expect([...(await source.read(1, 2))]).toEqual([2, 3]);
  await expect(source.read(2, 2)).rejects.toThrow("outside disc file");
  expect(() => checkRange(3, -1, 1)).toThrow();
  expect(() => localSources([file, file])).toThrow("Duplicate");
});

test("folder selection ignores unrelated files and rejects ambiguous filenames", async () => {
  const cueFile = new File([cue], "disc.CUE");
  const track = new File([new Uint8Array([1, 2, 3])], "DATA.BIN");
  const artwork = new File(["cover"], "cover.jpg");
  const sources = directorySources([artwork, cueFile, track]);
  expect([...sources.keys()]).toEqual(["disc.cue", "data.bin"]);
  expect([...(await sources.get("data.bin")!.read(0, 3))]).toEqual([1, 2, 3]);
  expect(() => directorySources([artwork])).toThrow("No CUE or BIN");
  expect(() => directorySources([track, new File([], "data.bin")])).toThrow("Duplicate");
  await expect(
    discTracks(directorySources([cueFile, new File([cue], "second.cue")]), reference, () => {}),
  ).rejects.toThrow("only one disc CUE");
});

test("EXE checksum mismatch fails independently of resources", async () => {
  const bytes = new TextEncoder().encode("test executable");
  const hash = await sha256(bytes);
  expect(await verifyExecutable(bytes, hash)).toBe(hash);
  await expect(verifyExecutable(bytes, reference.executable.sha256)).rejects.toThrow(
    "Unsupported SCUS",
  );
});

test("MODE2 extraction checks sync, subheader and form", async () => {
  const bytes = new Uint8Array(2352);
  bytes.fill(255, 1, 11);
  bytes[15] = 2;
  bytes[24] = 42;
  const source = (data: Uint8Array<ArrayBuffer>) =>
    localSources([new File([data], "data.bin")]).get("data.bin")!;
  expect((await new Disc(source(bytes)).read(0, 1))[0]).toBe(42);
  bytes[18] = 32;
  bytes[22] = 32;
  await expect(new Disc(source(bytes)).read(0, 1)).rejects.toThrow("Form 1");
});

test("HTTP ranges support bounded reads and HEAD; invalid ranges fail", async () => {
  expect(byteRange("bytes=2-99", 10)).toEqual({ start: 2, end: 9 });
  expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  expect(byteRange("bytes=10-", 10)).toBeNull();
  expect(byteRange("bytes=3-1", 10)).toBeNull();
  const file = Bun.file(import.meta.path);
  const request = new Request("http://localhost/test", { headers: { Range: "bytes=0-3" } });
  const response = serveFile(request, file);
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe(`bytes 0-3/${file.size}`);
  expect((await response.arrayBuffer()).byteLength).toBe(4);
  const head = serveFile(new Request(request, { method: "HEAD" }), file);
  expect((await head.arrayBuffer()).byteLength).toBe(0);
});
