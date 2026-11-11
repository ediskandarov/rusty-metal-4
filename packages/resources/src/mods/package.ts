import { type MrDirectory, readMr } from "../compatibility/mr.ts";
import { validateCarDisplay } from "./car-display.ts";
import {
  checkIndependentCar,
  independentFiles,
  independentFolders,
  requireKeys,
} from "./independent-car.ts";
import { binary, directory, stringEntry, stringValue, writeMr } from "./mr-writer.ts";

export const maxModBytes = 4 * 1024 * 1024;
export const maxCarMods = 16;
interface CarModIdentity {
  format: "tm4-rewired-mod";
  kind: "car";
  id: string;
  name: string;
}
export type CarModManifest = CarModIdentity & ({ version: 1; base: string } | { version: 2 });
export interface CarMod {
  manifest: CarModManifest;
  model: MrDirectory;
  bytes: Uint8Array<ArrayBuffer>;
  warnings: string[];
}
export function parseManifest(value: unknown): CarModManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid mod manifest");
  const m = value as Record<string, unknown>;
  if (m.format !== "tm4-rewired-mod" || (m.version !== 1 && m.version !== 2) || m.kind !== "car")
    throw new Error("Unsupported car mod format/version");
  if (
    Object.keys(m).some(
      (k) =>
        !["format", "version", "kind", "id", "name", ...(m.version === 1 ? ["base"] : [])].includes(
          k,
        ),
    )
  )
    throw new Error("Unknown manifest field");
  if (typeof m.id !== "string" || !/^[a-z][a-z0-9]{0,6}$/.test(m.id))
    throw new Error("Mod id: use 1–7 lowercase ASCII letters or digits");
  if (
    typeof m.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9 '-]{0,14}$/.test(m.name) ||
    m.name.trim() !== m.name
  )
    throw new Error("Car name: use 1–15 ASCII letters, digits, spaces, apostrophes or hyphens");
  const identity = { format: m.format, kind: m.kind, id: m.id, name: m.name } as const;
  if (m.version === 2) return { ...identity, version: 2 };
  if (typeof m.base !== "string" || !/^[a-z][a-z0-9]{0,7}$/.test(m.base))
    throw new Error("Invalid base car filename");
  return { ...identity, version: 1, base: m.base };
}

function checkModel(root: MrDirectory, independent: boolean) {
  requireKeys(
    root,
    ["machineGuns", ...(independent ? independentFiles : [])],
    ["display", ...(independent ? independentFolders : [])],
    "Car",
  );
  const display = root.folders.get("display");
  if (!display) throw new Error("Missing display resources");
  requireKeys(
    display,
    ["car.bit", "shadow"],
    independent ? ["resolution", "turbo"] : ["resolution"],
    "Display",
  );
  for (const key of ["car.bit", "shadow"]) {
    const entry = display.files.get(key);
    if (entry && entry.type !== 3) throw new Error(`Invalid ${key} registry type`);
  }
  const resolution = display.folders.get("resolution");
  if (!resolution) throw new Error("Missing resolution resources");
  requireKeys(
    resolution,
    [
      "FaceList",
      "VertexList",
      "VertexNormalList",
      "NumFaces",
      "NumVertices",
      "NumVertexNormals",
      "NumGroups",
      "scale",
      "translate",
    ],
    Array.from({ length: 9 }, (_, i) => `r${i}`),
    "Resolution",
  );
  for (const [key, entry] of resolution.files) {
    if (![3, 4, 5].includes(entry.type)) throw new Error(`Invalid ${key} registry type`);
  }
  for (const [name, lod] of resolution.folders) {
    requireKeys(
      lod,
      [
        "NumFaces",
        "NumVertices",
        "NumVertexNormals",
        "NumGroups",
        "maxDistanceToDisplay",
        "viewtable",
      ],
      ["Groups"],
      name,
    );
    for (const [key, entry] of lod.files) {
      if (entry.type !== (key === "viewtable" ? 3 : 4))
        throw new Error(`Invalid ${key} registry type`);
    }
    const groups = lod.folders.get("Groups");
    if (groups?.folders.size) throw new Error("Nested render groups are unsupported");
  }
  const guns = root.files.get("machineGuns");
  if (
    guns &&
    (guns.type !== 26 ||
      guns.arraySize < 1 ||
      guns.arraySize > 8 ||
      guns.bytes.length !== guns.arraySize * 16)
  )
    throw new Error("Invalid machineGuns coordinates/directions");
  if (independent) checkIndependentCar(root, display);
  if (!display.files.has("car.bit")) throw new Error("Car mod must supply its bitmap");
  const result = validateCarDisplay(root);
  if (result.errors.length) throw new Error(result.errors.join("; "));
  if (!result.faces || !result.vertices || !result.normals) throw new Error("Car model is empty");
  if (independent) {
    // Shield and freeze copy the entire face array using the sum of the per-LOD counts.
    let storedFaces = 0;
    for (const [name, lod] of resolution.folders) {
      const bytes = lod.files.get("NumFaces")!.bytes;
      storedFaces += new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(
        0,
        true,
      );
      if (Number(name.slice(1)) < result.lods - 1 && !lod.files.has("maxDistanceToDisplay"))
        throw new Error(`${name}: independent car must supply its LOD distance`);
    }
    if (storedFaces !== result.faces)
      throw new Error("LOD face counts disagree with the face array");
  }
  // Padding outside a mod's own allocation cannot be assumed; no borrowed VRAM either.
  if (result.warnings.some((w) => /beyond VertexList|outside car.bit/.test(w)))
    throw new Error("Car mod geometry/textures must stay inside their own allocations");
  const bitmap = display.files.get("car.bit")!.bytes;
  const rect = new DataView(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength);
  if ([640, 0, 192, 64].some((v, i) => rect.getInt16(i * 2, true) !== v))
    throw new Error("Car mods require the relocatable 192×64-word bitmap slot at (640, 0)");
  return result.warnings.filter(
    (warning) => !independent || !warning.startsWith("Optional turbo effect resources"),
  );
}
export async function readCarMod(bytes: Uint8Array<ArrayBuffer>): Promise<CarMod> {
  if (bytes.length > maxModBytes) throw new Error("Car mod exceeds 4 MiB");
  const { root, rootName } = await readMr(bytes);
  if (rootName !== "Root" || root.folders.size || root.files.size !== 2 || !root.files.has("car"))
    throw new Error("Expected a .tm4mod package with manifest and car resources");
  const manifest = parseManifest(JSON.parse(stringValue(root.files.get("manifest"))));
  const car = root.files.get("car")!;
  if (car.type !== 3 || car.bytes.length > maxModBytes) throw new Error("Invalid car payload");
  const decoded = await readMr(car.bytes);
  if (decoded.rootName !== "Root") throw new Error("Invalid car resource root");
  const warnings = checkModel(decoded.root, manifest.version === 2);
  return { manifest, model: decoded.root, bytes, warnings };
}
export async function packCarMod(manifest: unknown, model: Uint8Array<ArrayBuffer>) {
  const root = directory();
  root.files.set("manifest", stringEntry(JSON.stringify(parseManifest(manifest))));
  root.files.set("car", binary(model));
  const bytes = writeMr(root);
  await readCarMod(bytes);
  return bytes;
}
