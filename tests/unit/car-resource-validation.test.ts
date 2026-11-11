import { expect, test } from "bun:test";

import type { MrDirectory } from "@tm4/resources/compatibility/mr";
import { validateCarDisplay, validateCarMr } from "@tm4/resources/mods/car-display";

const directory = (): MrDirectory => ({ files: new Map(), folders: new Map() });
function put(directory: MrDirectory, name: string, bytes: Uint8Array<ArrayBuffer>, type = 3) {
  directory.files.set(name, { type, arraySize: type === 4 ? 1 : 65535, bytes });
  return new DataView(bytes.buffer);
}
function count(directory: MrDirectory, name: string, value: number) {
  put(directory, name, new Uint8Array(4), 4).setInt32(0, value, true);
}

// A source-free single-triangle car display with a 32x16-word bitmap at (64, 32).
// Its palette/page, dimensions and group name deliberately differ from Evelyn's.
function fixture() {
  const root = directory();
  const display = directory();
  const resolution = directory();
  const lod = directory();
  const groups = directory();
  root.folders.set("display", display);
  display.folders.set("resolution", resolution);
  resolution.folders.set("r0", lod);
  lod.folders.set("Groups", groups);
  count(resolution, "NumFaces", 1);
  count(resolution, "NumVertexNormals", 3);
  count(lod, "NumFaces", 1);
  const face = put(resolution, "FaceList", new Uint8Array(24));
  face.setUint8(0, 0x24);
  for (const offset of [4, 8, 12]) {
    face.setUint8(offset, 0);
    face.setUint8(offset + 1, 33);
  }
  face.setUint16(6, 32 * 64 + 4, true);
  face.setUint16(10, 1, true);
  for (let i = 0; i < 3; i++) {
    face.setUint8(16 + i, i);
    face.setUint8(20 + i, i);
  }
  put(resolution, "VertexList", new Uint8Array(24));
  const normals = put(resolution, "VertexNormalList", new Uint8Array(24));
  for (let i = 0; i < 3; i++) {
    normals.setInt16(i * 8 + 2, -4096, true);
    normals.setInt16(i * 8 + 6, i, true);
  }
  const group = put(groups, "arbitrary_body", new Uint8Array(32));
  for (const offset of [0, 12]) {
    group.setInt16(offset + 2, 1, true);
    group.setInt16(offset + 6, 3, true);
    group.setInt16(offset + 10, 3, true);
  }
  group.setUint8(30, 1);
  const selection = put(lod, "viewtable", new Uint8Array([1, 0]));
  const bitmap = put(display, "car.bit", new Uint8Array(8 + 32 * 16 * 2));
  [64, 32, 32, 16].forEach((value, i) => bitmap.setInt16(i * 2, value, true));
  const shadow = put(display, "shadow", new Uint8Array(8));
  shadow.setUint8(1, 33);
  shadow.setUint8(5, 33);
  shadow.setUint16(2, 32 * 64 + 4, true);
  shadow.setUint16(6, 1, true);
  return { root, display, resolution, lod, groups, face, normals, group, selection, bitmap };
}

test("car display validation has no source-art, fixed-atlas or wheel-count dependency", () => {
  const result = validateCarDisplay(fixture().root);
  expect(result.errors).toEqual([]);
  expect(result.checkedCorners).toBe(6);
  expect(result.maxScratchBytes).toBe(30);
  expect(result.warnings.some((message) => message.includes("external VRAM"))).toBe(false);
  expect(result.warnings.some((message) => message.includes("One LOD"))).toBe(true);
  expect(result.warnings.some((message) => message.includes("damage art"))).toBe(true);
});

test("in-range normal association is warned by default and fails strict exporter fidelity", () => {
  const f = fixture();
  f.normals.setInt16(6, 1, true);
  const general = validateCarDisplay(f.root);
  expect(general.errors).toEqual([]);
  expect(general.representativeCorners).toBe(2);
  expect(general.warnings.some((message) => message.includes("reflection lookup"))).toBe(true);
  expect(validateCarDisplay(f.root, { strictAssociations: true }).errors[0]).toContain(
    "association fidelity",
  );
});

test("out-of-range normal projections and both corner index arrays fail", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.normals.setInt16(6, 3, true),
    (f: ReturnType<typeof fixture>) => f.face.setUint8(16, 3),
    (f: ReturnType<typeof fixture>) => f.face.setUint8(20, 3),
  ]) {
    const f = fixture();
    mutate(f);
    expect(validateCarDisplay(f.root).errors[0]).toContain("out of range");
  }
});

test("group extents, view indices, face allocation and payload types fail clearly", () => {
  for (const [mutate, message] of [
    [(f) => f.group.setInt16(2, 2, true), "range exceeds"],
    [(f) => f.selection.setUint8(1, 1), "view row index"],
    [(f) => count(f.lod, "NumFaces", 0), "understates"],
    [
      (f) => {
        f.resolution.files.get("FaceList")!.type = 4;
      },
      "registry type",
    ],
    [
      (f) => {
        f.resolution.files.get("VertexList")!.bytes = new Uint8Array(23);
      },
      "partial SVECTOR",
    ],
  ] as const satisfies readonly (readonly [(f: ReturnType<typeof fixture>) => void, string])[]) {
    const f = fixture();
    mutate(f);
    expect(validateCarDisplay(f.root).errors[0]).toContain(message);
  }
});

test("renderer scratch overflow is detected independently of an artist budget", () => {
  const f = fixture();
  put(f.resolution, "VertexList", new Uint8Array(90 * 8));
  put(f.resolution, "VertexNormalList", new Uint8Array(90 * 8));
  count(f.resolution, "NumVertexNormals", 90);
  f.group.setInt16(6, 90, true);
  f.group.setInt16(10, 90, true);
  expect(validateCarDisplay(f.root).errors[0]).toContain("scratch overflow");
});

test("bitmap extent, reserved depth and CLUT addressing are checked", () => {
  for (const [mutate, message] of [
    [(f) => f.bitmap.setInt16(4, 33, true), "pixel extent"],
    [(f) => f.face.setUint16(10, 3 << 7, true), "reserved texture depth"],
    [
      (f) => {
        f.face.setUint16(10, 1 << 7, true);
        f.face.setUint16(6, 63, true);
      },
      "CLUT address",
    ],
  ] as const satisfies readonly (readonly [(f: ReturnType<typeof fixture>) => void, string])[]) {
    const f = fixture();
    mutate(f);
    expect(validateCarDisplay(f.root).errors[0]).toContain(message);
  }
  const f = fixture();
  f.display.files.delete("car.bit");
  expect(validateCarDisplay(f.root).errors).toEqual([]);
  expect(validateCarDisplay(f.root).warnings.join(" ")).toContain("external VRAM");
});

test("a recomputed wheel pivot is reported without guessing intended dimensions", () => {
  const f = fixture();
  const entry = f.groups.files.get("arbitrary_body")!;
  f.groups.files.clear();
  f.groups.files.set("fl_wheel_custom", entry);
  f.group.setUint8(30, 0);
  expect(validateCarDisplay(f.root).errors).toEqual([]);
  expect(validateCarDisplay(f.root).warnings.join(" ")).toContain("authored pivot is not fixed");
});

test("invalid MR containers produce a failing report", async () => {
  expect((await validateCarMr(new Uint8Array([0x67]))).errors[0]).toContain("MR container");
});
