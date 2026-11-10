import { type MrDirectory, readMr } from "../compatibility/mr.ts";
import type { DiscAssets } from "../loader/types.ts";
import { binary, stringEntry, stringValue, writeMr } from "./mr-writer.ts";
import { type CarMod, maxCarMods } from "./package.ts";

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
  const preview = clone(model);
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

/** Build a private session view. Neither the user's disc nor the installed packages are changed. */
export async function installCarMods(assets: DiscAssets, mods: readonly CarMod[]): Promise<void> {
  if (!mods.length) return;
  if (mods.length > maxCarMods) throw new Error(`At most ${maxCarMods} car mods per session`);
  const files = new Map(assets.files);
  async function archive(path: string) {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`Missing mod dependency on disc: ${path}`);
    return (await readMr(bytes)).root;
  }
  const main = await archive("/DATA/MAIN.MR");
  const menu = await archive("/DATA/MENU.MR");
  const previews = await archive("/DATA/MENU/CHAR.MR");
  const characters = folder(main, "objects/car/characters");
  const screens = folder(menu, "menu/screens");
  const menuCars = folder(previews, "menucars");
  const originals = [...characters.folders];
  const names = new Set(originals.map(([name]) => name.toLowerCase()));
  const ids = new Set<string>();
  for (const mod of mods) {
    const { id, name, base } = mod.manifest;
    const filename = `m${id}`;
    if (
      ids.has(id) ||
      names.has(name.toLowerCase()) ||
      files.has(`/DATA/${filename.toUpperCase()}.MR`) ||
      menuCars.files.has(filename)
    )
      throw new Error(`Mod conflicts with an existing car: ${name} (${id})`);
    ids.add(id);
    names.add(name.toLowerCase());
    const source = originals.find(([, value]) => {
      const entry = value.files.get("filename");
      return entry && stringValue(entry).toLowerCase() === base;
    });
    if (!source) throw new Error(`${name}: base car ${base} is absent from this disc`);
    const model = await archive(`/DATA/${base.toUpperCase()}.MR`);
    const originalDisplay = folder(model, "display");
    const display = clone(originalDisplay);
    const replacement = mod.model.folders.get("display")!;
    for (const [key, value] of replacement.files) display.files.set(key, value);
    // Replace the entire geometry tree: old LODs must not reappear at a distance.
    display.folders.set("resolution", clone(folder(replacement, "resolution")));
    model.folders.set("display", display);
    for (const [key, value] of mod.model.files) model.files.set(key, value);
    files.set(`/DATA/${filename.toUpperCase()}.MR`, writeMr(model));
    const character = clone(source[1]);
    character.files.set("filename", stringEntry(filename));
    character.files.set("behavior", stringEntry(base));
    characters.folders.set(name, character);
    menuCars.files.set(filename, binary(writeMr(createCarPreview(mod.model))));
    // Info pages are inherited alongside behavior until a mod supplies its own presentation.
    const info = screens.folders.get(base);
    if (info) screens.folders.set(filename, clone(info));
  }
  files.set("/DATA/MAIN.MR", writeMr(main));
  files.set("/DATA/MENU.MR", writeMr(menu));
  files.set("/DATA/MENU/CHAR.MR", writeMr(previews));
  const manifestBytes = files.get("/DATA/files.tsv");
  if (!manifestBytes) throw new Error("Missing disc file index");
  const rows = new TextDecoder()
    .decode(manifestBytes)
    .trim()
    .split("\n")
    .map((row) => {
      const [lba, size, path] = row.split("\t");
      if (!path || !Number.isSafeInteger(Number(lba)) || !Number.isSafeInteger(Number(size)))
        throw new Error("Invalid disc file index");
      return { lba: Number(lba), size: Number(size), path };
    });
  let sector = Math.max(...rows.map((r) => r.lba + Math.ceil(r.size / 2048)));
  const indexed = new Set(rows.map((r) => r.path));
  for (const row of rows) row.size = files.get(row.path)?.length ?? row.size;
  for (const [path, data] of files) {
    if (indexed.has(path) || path === "/DATA/files.tsv") continue;
    rows.push({ lba: sector, size: data.length, path });
    sector += Math.ceil(data.length / 2048);
  }
  if (sector + 150 >= 100 * 60 * 75) throw new Error("Virtual CD address capacity exceeded");
  files.set(
    "/DATA/files.tsv",
    new TextEncoder().encode(rows.map((r) => `${r.lba}\t${r.size}\t${r.path}`).join("\n") + "\n"),
  );
  assets.files = files;
}
