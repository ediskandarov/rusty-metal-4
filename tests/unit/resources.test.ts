import { expect, test } from "bun:test";

import reference from "../../config/disc.json";
import resources from "../../config/resources.json";
import { discTracks, parseCue } from "../../web/src/loader/cue.ts";
import { checkResources, resourceRows } from "../../web/src/loader/resources.ts";
import type { ResourceCandidate } from "../../web/src/loader/resources.ts";
import { localSources } from "../../web/src/loader/sources.ts";
import { sha256 } from "../../web/src/loader/verify.ts";

const bytes = new Uint8Array([1, 2, 3]);
const candidate = (id: string): ResourceCandidate => ({
  id,
  size: bytes.length,
  read: () => Promise.resolve(bytes),
});

test("resource audit separates identity, modification, absence, unknown and read failure", async () => {
  const hash = await sha256(bytes);
  const found = [
    candidate("original"),
    candidate("modified"),
    candidate("unknown"),
    {
      id: "bad",
      size: 3,
      read: () => Promise.reject(new Error("Invalid sector")),
    },
  ];
  const expected = [
    { id: "original", size: 3, sha256: hash },
    { id: "modified", size: 3, sha256: "0".repeat(64) },
    { id: "missing", size: 3, sha256: hash },
  ];
  const rows = resourceRows(found, expected);
  await checkResources(found, rows, new AbortController().signal, () => {});
  expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
    original: "original",
    modified: "modified",
    missing: "missing",
    unknown: "unknown",
    bad: "error",
  });
  expect(rows.find((row) => row.id === "bad")?.error).toBe("Invalid sector");
  expect(rows.find((row) => row.id === "unknown")?.hash).toBe(hash);
});

test("cancelled checks reset the active row and can resume without rereading completed files", async () => {
  const controller = new AbortController();
  let reads = 0;
  const found = [
    candidate("a"),
    {
      id: "b",
      size: 3,
      read: () => {
        reads++;
        controller.abort();
        return Promise.resolve(bytes);
      },
    },
  ];
  const rows = resourceRows(found, []);
  await expect(checkResources(found, rows, controller.signal, () => {})).rejects.toThrow();
  expect(rows.map((row) => row.status)).toEqual(["unknown", "pending"]);
  await checkResources(found, rows, new AbortController().signal, () => {});
  expect(rows.map((row) => row.status)).toEqual(["unknown", "unknown"]);
  expect(reads).toBe(2);
});

test("shared-BIN CUE can be inspected without silently enabling unsupported playback", async () => {
  const cue =
    'FILE "disc.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n PREGAP 00:02:00\n INDEX 01 00:10:00\n TRACK 03 AUDIO\n ISRC 123456789012\n INDEX 00 00:20:00\n INDEX 01 00:22:00\n';
  const tracks = parseCue(cue);
  expect(tracks[1]?.index).toBe(750);
  expect(tracks[2]?.index0).toBe(1500);
  expect(tracks[2]?.index).toBe(1650);
  expect(() => parseCue(cue.replace("PREGAP 00:02:00", "PREGAP 00:02:75"))).toThrow();
  await expect(
    discTracks(localSources([new File([cue], "disc.cue")]), reference, () => {}),
  ).rejects.toThrow("can still be inspected");
});

test("resource reference contains metadata only and keeps executable hash authoritative in disc.json", () => {
  expect(new Set(resources.files.map((file) => file.id)).size).toBe(resources.files.length);
  expect(resources.files.filter((file) => file.id.endsWith(".MR"))).toHaveLength(135);
  expect(resources.files.some((file) => file.id === "/SCUS_945.60")).toBe(false);
  for (const file of resources.files) {
    expect(Object.keys(file).sort()).toEqual(["id", "sha256", "size"]);
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(file.size).toBeGreaterThan(0);
  }
});
