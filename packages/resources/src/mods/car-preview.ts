import type { MrDirectory } from "../compatibility/mr.ts";
import { directory } from "./mr-writer.ts";

function folder(root: MrDirectory, path: string): MrDirectory {
  let value = root;
  for (const key of path.split("/")) {
    const child = value.folders.get(key);
    if (!child) throw new Error(`Disc is missing ${path}`);
    value = child;
  }
  return value;
}
function clone(value: MrDirectory): MrDirectory {
  return {
    files: new Map(value.files),
    folders: new Map([...value.folders].map(([name, d]) => [name, clone(d)])),
  };
}

/** The menu consumes car-space vertices; the driving renderer applies wheel pivots itself. */
export function createCarPreview(model: MrDirectory): MrDirectory {
  const preview = directory();
  preview.folders.set("display", clone(folder(model, "display")));
  preview.folders.get("display")!.folders.delete("turbo");
  const resolution = folder(preview, "display/resolution");
  const source = resolution.files.get("VertexList")!;
  const bytes = source.bytes.slice();
  const vertices = new DataView(bytes.buffer);
  const offsets = new Map<number, number[]>();
  const groups = folder(resolution, "r0/Groups");
  for (const [name, entry] of groups.files) {
    const groupBytes = entry.bytes.slice();
    const group = new DataView(groupBytes.buffer);
    const offset = [0, 1, 2].map((axis) => group.getInt16(24 + axis * 2, true));
    if (!group.getUint8(30)) continue;
    for (const frame of [0, 12]) {
      const first = group.getInt16(frame + 4, true),
        count = group.getInt16(frame + 6, true);
      for (let i = first; i < first + count; ++i) {
        const previous = offsets.get(i);
        if (previous && previous.some((value, axis) => value !== offset[axis]))
          throw new Error("Car preview has conflicting group pivots");
        offsets.set(i, offset);
      }
    }
    group.setUint8(30, 0);
    groups.files.set(name, { ...entry, bytes: groupBytes });
  }
  for (const [index, offset] of offsets) {
    for (let axis = 0; axis < 3; ++axis) {
      const position = index * 8 + axis * 2;
      const value = vertices.getInt16(position, true) + offset[axis]!;
      if (value < -32768 || value > 32767)
        throw new Error("Car preview coordinate exceeds signed 16 bits");
      vertices.setInt16(position, value, true);
    }
  }
  resolution.files.set("VertexList", { ...source, bytes });
  return preview;
}
