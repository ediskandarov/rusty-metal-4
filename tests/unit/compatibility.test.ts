import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import {
  checkResources,
  compatibilityReport,
  requireResources,
  resourceRows,
  sha256,
  validateMainRegistry,
} from "@tm4/resources/compatibility";
import type { ResourceCandidate, ResourceReference } from "@tm4/resources/compatibility";

const signal = () => new AbortController().signal;
const payload = new Uint8Array([1, 2, 3, 4]);
const exe = new Uint8Array(2048);
exe.set(new TextEncoder().encode("PS-X EXE"));
const ids = ["/SCUS_945.60", "/DATA/SOUND.VAB", "AUDIO/02"];
const hash = await sha256(payload);
const reference: ResourceReference[] = ids.map((id) => ({
  id,
  size: id === "/SCUS_945.60" ? exe.length : payload.length,
  sha256: hash,
}));
const candidates = (): ResourceCandidate[] =>
  ids.map((id) => ({
    id,
    size: id === "/SCUS_945.60" ? exe.length : payload.length,
    read: () => Promise.resolve(id === "/SCUS_945.60" ? exe : payload),
  }));
async function report(found: ResourceCandidate[]) {
  const rows = resourceRows(found, reference);
  await checkResources(found, rows, signal(), () => {});
  return compatibilityReport(rows);
}

test("known supported resources pass; unverified formats warn without blocking", async () => {
  expect((await report(candidates())).status).toBe("compatible");
  const found = candidates();
  found[1]!.read = () => Promise.resolve(new Uint8Array([5, 6, 7, 8]));
  expect((await report(found)).status).toBe("warning");
  expect(
    (
      await report([
        ...candidates(),
        { id: "/DATA/EXTRA.VAB", size: 4, read: () => Promise.resolve(payload) },
      ])
    ).status,
  ).toBe("warning");
});

test("EXE remains required while missing or different music is compatible", async () => {
  const found = candidates();
  found[2]!.read = () => Promise.resolve(new Uint8Array([9, 8, 7, 6]));
  expect((await report(found)).status).toBe("compatible");
  const required = found.filter((entry) => !entry.id.startsWith("AUDIO/"));
  expect(() => requireResources(required, reference)).not.toThrow();
  expect((await report(required)).status).toBe("compatible");
});

test("missing required resources fail the same presence policy as startup", () => {
  for (const id of ["/DATA/SOUND.VAB", "/SCUS_945.60"]) {
    const found = candidates().filter((entry) => entry.id !== id);
    expect(() => requireResources(found, reference)).toThrow(id);
    expect(compatibilityReport(resourceRows(found, reference))).toEqual({
      status: "uncompatible",
      problems: [`${id}: Required resource is missing`],
    });
  }
});

test("read failures are errors for required data and warnings for optional audio", async () => {
  for (const index of [1, 2]) {
    const found = candidates();
    found[index]!.read = () => Promise.reject(new Error("Bad sector"));
    const result = await report(found);
    expect(result.status).toBe(index === 1 ? "uncompatible" : "warning");
    if (index === 1) expect(result.problems).toEqual(["/DATA/SOUND.VAB: Bad sector"]);
  }
});

test("unchecked rows cannot claim compatibility and duplicate resources are rejected", () => {
  expect(compatibilityReport(resourceRows(candidates(), reference)).status).toBe("checking");
  expect(compatibilityReport([]).status).toBe("checking");
  expect(() => requireResources([...candidates(), candidates()[0]!], reference)).toThrow(
    "Duplicate resource",
  );
});

// Synthetic MR fixtures contain no game data. Header layout mirrors the on-disc registry.
interface TestFile {
  name: string;
  type: number;
  bytes: Uint8Array<ArrayBuffer>;
  unpacked?: number;
}
function concat(...parts: Uint8Array<ArrayBuffer>[]) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
function string(value: string) {
  const bytes = new Uint8Array((value.length + 4) & ~3);
  bytes.set(new TextEncoder().encode(value));
  return bytes;
}
function directory(name: string, files: TestFile[] = [], children: Uint8Array<ArrayBuffer>[] = []) {
  const padded = string(name);
  const header = new Uint8Array(4);
  const view = new DataView(header.buffer);
  header[0] = padded.length;
  header[1] = children.length;
  view.setUint16(2, files.length, true);
  return concat(
    header,
    padded,
    ...files.map((file) => {
      const name = string(file.name);
      const header = new Uint8Array(12);
      const view = new DataView(header.buffer);
      header[0] = name.length;
      header[1] = file.type;
      view.setUint16(2, 65535, true);
      view.setUint32(4, file.bytes.length, true);
      view.setUint32(8, file.unpacked ?? 0, true);
      return concat(header, name, file.bytes);
    }),
    ...children,
  );
}
function main(
  options: {
    filenameType?: number;
    compressed?: boolean;
    padding?: number;
    unpacked?: number;
    numberType?: number;
    extra?: Uint8Array<ArrayBuffer>[];
  } = {},
) {
  const name = string("car");
  const car: TestFile = {
    name: "filename",
    type: options.filenameType ?? 2,
    bytes: options.compressed
      ? concat(new Uint8Array(deflateSync(name)), new Uint8Array(options.padding ?? 0))
      : name,
    unpacked: options.unpacked ?? (options.compressed ? name.length : 0),
  };
  const number: TestFile = {
    name: "musicTrackNum",
    type: options.numberType ?? 4,
    bytes: new Uint8Array([99, 0, 0, 0]),
  };
  return concat(
    new Uint8Array([0x67, 0, 0xcc, 0xcc]),
    directory(
      "Root",
      [],
      [
        directory(
          "objects",
          [],
          [directory("car", [], [directory("characters", [], [directory("Custom name", [car])])])],
        ),
        directory(
          "worlds",
          [],
          [directory("Custom map", [{ name: "filename", type: 2, bytes: string("map") }, number])],
        ),
        directory("rankings", [{ name: "Custom rank", type: 4, bytes: payload }]),
        ...(options.extra ?? []),
      ],
    ),
  );
}
const available = new Set(["/DATA/CAR.MR", "/DATA/MAP.MR"]);

test("MAIN accepts changed labels, values, addresses and absent music", async () => {
  await validateMainRegistry(
    main({ extra: [directory("os", [{ name: "Function", type: 3, bytes: payload }])] }),
    available,
  );
  await validateMainRegistry(main(), available); // Original executable symbols are not required.
});

test("MAIN validates filename and numeric types and referenced resource presence", async () => {
  await expect(validateMainRegistry(main({ filenameType: 4 }), available)).rejects.toThrow(
    "filename string",
  );
  await expect(validateMainRegistry(main({ numberType: 2 }), available)).rejects.toThrow(
    "32-bit number",
  );
  await expect(validateMainRegistry(main(), new Set(["/DATA/CAR.MR"]))).rejects.toThrow("map.MR");
});

test("MAIN rejects broken headers, truncation, missing directories and duplicate entries", async () => {
  const bytes = main();
  const badMagic = bytes.slice();
  badMagic[0] = 0;
  await expect(validateMainRegistry(badMagic, available)).rejects.toThrow("signature");
  await expect(
    validateMainRegistry(bytes.subarray(0, bytes.length - 1), available),
  ).rejects.toThrow("Truncated");
  await expect(
    validateMainRegistry(concat(bytes, new Uint8Array([42])), available),
  ).rejects.toThrow("Unexpected data");
  await expect(
    validateMainRegistry(concat(bytes.subarray(0, 4), directory("Root")), available),
  ).rejects.toThrow("Missing MAIN.MR directory");
  await expect(
    validateMainRegistry(main({ extra: [directory("rankings")] }), available),
  ).rejects.toThrow("Duplicate");
});

test("MAIN checks compressed sizes, limits and cancellation", async () => {
  await validateMainRegistry(main({ compressed: true }), available);
  await validateMainRegistry(main({ compressed: true, padding: 3 }), available);
  await expect(
    validateMainRegistry(main({ compressed: true, unpacked: 3 }), available),
  ).rejects.toThrow("Oversized");
  await expect(
    validateMainRegistry(main({ compressed: true, unpacked: 8 }), available),
  ).rejects.toThrow("Truncated compressed");
  await expect(
    validateMainRegistry(main({ compressed: true, unpacked: 0xffffffff }), available),
  ).rejects.toThrow("size limit");
  const controller = new AbortController();
  controller.abort();
  await expect(validateMainRegistry(main(), available, controller.signal)).rejects.toThrow();
});

test("MAIN format failure is Uncompatible through the public resource audit", async () => {
  const broken = main({ filenameType: 4 });
  const found = [
    { id: "/DATA/MAIN.MR", size: broken.length, read: () => Promise.resolve(broken) },
    ...[...available].map((id) => ({ id, size: 4, read: () => Promise.resolve(payload) })),
  ];
  const rows = resourceRows(found, [
    { id: "/DATA/MAIN.MR", size: broken.length, sha256: await sha256(broken) },
  ]);
  await checkResources(found, rows, signal(), () => {});
  expect(compatibilityReport(rows).status).toBe("uncompatible");
  expect(rows.find((row) => row.id === "/DATA/MAIN.MR")?.message).toContain("filename string");
});
