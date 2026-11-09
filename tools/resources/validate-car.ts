import { resolve } from "node:path";

import { type MrDirectory, type MrEntry, readMr } from "../../web/src/compatibility/mr.ts";

export interface CarDisplayReport {
  errors: string[];
  warnings: string[];
  faces: number;
  vertices: number;
  normals: number;
  groups: number;
  lods: number;
  checkedCorners: number;
  representativeCorners: number;
  maxScratchBytes: number;
}

export interface CarDisplayOptions {
  // Useful for exporters that promise one projected vertex per authored corner normal.
  // The loader can also use an in-range representative position for reflection UVs.
  strictAssociations?: boolean;
}

function report(): CarDisplayReport {
  return {
    errors: [],
    warnings: [],
    faces: 0,
    vertices: 0,
    normals: 0,
    groups: 0,
    lods: 0,
    checkedCorners: 0,
    representativeCorners: 0,
    maxScratchBytes: 0,
  };
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function view(bytes: Uint8Array<ArrayBuffer>) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function payload(directory: MrDirectory, name: string, type: number, minimum = 0): MrEntry {
  const entry = directory.files.get(name);
  requireValue(entry, `Missing ${name}`);
  requireValue(entry.type === type, `${name}: expected registry type ${type}, got ${entry.type}`);
  requireValue(entry.bytes.length >= minimum, `${name}: truncated payload`);
  return entry;
}

function integer(directory: MrDirectory, name: string, nonnegative = true) {
  const entry = payload(directory, name, 4, 4);
  requireValue(entry.bytes.length === 4, `${name}: expected one signed 32-bit value`);
  const value = view(entry.bytes).getInt32(0, true);
  requireValue(!nonnegative || value >= 0, `${name}: negative count`);
  return value;
}

function child(directory: MrDirectory, name: string) {
  const result = directory.folders.get(name);
  requireValue(result, `Missing directory ${name}`);
  return result;
}

const wheelPrefixes = ["fl_wheel", "fr_wheel", "rr_wheel", "rl_wheel"];

/** Validate display resources consumed by the recovered car renderer, without source art. */
export function validateCarDisplay(
  root: MrDirectory,
  options: CarDisplayOptions = {},
): CarDisplayReport {
  const result = report();
  const warnings = new Set<string>();
  const warn = (message: string) => warnings.add(message);
  try {
    const display = child(root, "display");
    const resolution = child(display, "resolution");
    if (display.folders.has("turbo"))
      warn("Optional turbo effect resources are outside this geometry/texture validator's scope.");
    const faceBytes = payload(resolution, "FaceList", 3).bytes;
    const vertexBytes = payload(resolution, "VertexList", 3).bytes;
    const normalBytes = payload(resolution, "VertexNormalList", 3).bytes;
    result.faces = integer(resolution, "NumFaces");
    result.normals = integer(resolution, "NumVertexNormals");
    requireValue(faceBytes.length === result.faces * 24, "FaceList extent disagrees with NumFaces");
    requireValue(vertexBytes.length % 8 === 0, "VertexList has a partial SVECTOR");
    requireValue(
      normalBytes.length === result.normals * 8,
      "VertexNormalList extent disagrees with NumVertexNormals",
    );
    result.vertices = vertexBytes.length / 8;
    if (resolution.files.has("NumVertices")) {
      requireValue(
        integer(resolution, "NumVertices") === result.vertices,
        "VertexList extent disagrees with NumVertices",
      );
    }
    const faces = view(faceBytes);
    const normals = view(normalBytes);

    // A bitmap is optional to the loader: references outside it can be supplied elsewhere.
    let bitmap: { x: number; y: number; width: number; height: number } | undefined;
    if (display.files.has("car.bit")) {
      const bytes = payload(display, "car.bit", 3, 8).bytes;
      const data = view(bytes);
      bitmap = {
        x: data.getInt16(0, true),
        y: data.getInt16(2, true),
        width: data.getInt16(4, true),
        height: data.getInt16(6, true),
      };
      requireValue(
        bitmap.x >= 0 && bitmap.y >= 0 && bitmap.width > 0 && bitmap.height > 0,
        "car.bit: invalid rectangle",
      );
      requireValue(
        bitmap.x + bitmap.width <= 1024 && bitmap.y + bitmap.height <= 512,
        "car.bit: rectangle exceeds VRAM",
      );
      requireValue(
        bytes.length === 8 + 2 * bitmap.width * bitmap.height,
        "car.bit: pixel extent disagrees with rectangle",
      );
    } else warn("No car.bit: texture contents and external VRAM dependencies are not verified.");

    let externalTextureReferences = 0;
    const inBitmap = (x: number, y: number, words = 1) =>
      bitmap &&
      x >= bitmap.x &&
      y >= bitmap.y &&
      x + words <= bitmap.x + bitmap.width &&
      y < bitmap.y + bitmap.height;
    function checkTexture(clut: number, page: number, uv: number[][], label: string) {
      const mode = (page >> 7) & 3;
      requireValue(mode !== 3, `${label}: reserved texture depth`);
      const pageX = (page & 15) * 64;
      const pageY = ((page & 16) << 4) | ((page & 2048) >> 2);
      const pixelsPerWord = [4, 2, 1][mode]!;
      for (const [u, v] of uv) {
        const x = pageX + Math.floor(u! / pixelsPerWord);
        const y = pageY + v!;
        requireValue(x < 1024 && y < 512, `${label}: texture address exceeds VRAM`);
        if (bitmap && !inBitmap(x, y)) externalTextureReferences++;
      }
      if (mode < 2) {
        const x = (clut & 63) * 16;
        const y = clut >> 6;
        const colors = mode === 0 ? 16 : 256;
        requireValue(x + colors <= 1024 && y < 512, `${label}: CLUT address exceeds VRAM`);
        if (bitmap && !inBitmap(x, y, colors)) externalTextureReferences++;
      }
    }

    const shadow = view(payload(display, "shadow", 3, 8).bytes);
    checkTexture(
      shadow.getUint16(2, true),
      shadow.getUint16(6, true),
      [
        [shadow.getUint8(0), shadow.getUint8(1)],
        [shadow.getUint8(4), shadow.getUint8(5)],
      ],
      "shadow",
    );

    // Relocation walks the complete FaceList, including unselected LOD/frame records.
    for (let face = 0; face < result.faces; face++) {
      const offset = face * 24;
      const code = faces.getUint8(offset);
      requireValue(
        code === 0x24 || code === 0x2c,
        `Face ${face}: unsupported car polygon opcode 0x${code.toString(16)}`,
      );
      const degree = code === 0x24 ? 3 : 4;
      const uvOffsets = [4, 8, 12, 14].slice(0, degree);
      const uv = uvOffsets.map((i) => [faces.getUint8(offset + i), faces.getUint8(offset + i + 1)]);
      checkTexture(
        faces.getUint16(offset + 6, true),
        faces.getUint16(offset + 10, true),
        uv,
        `Face ${face}`,
      );
    }

    const levels = [...resolution.folders.keys()].filter((name) => /^r\d+$/.test(name));
    requireValue(
      levels.length > 0 && levels.length <= 9,
      "Expected one to nine contiguous car LOD directories",
    );
    for (let i = 0; i < levels.length; i++)
      requireValue(resolution.folders.has(`r${i}`), "LOD directories must be contiguous from r0");
    result.lods = levels.length;
    let allFramesAliased = true;
    const usedWheelKinds = new Set<number>();
    let previousDistance: number | undefined;
    for (let lodIndex = 0; lodIndex < levels.length; lodIndex++) {
      const lodName = `r${lodIndex}`;
      const lod = child(resolution, lodName);
      const groupDirectory = child(lod, "Groups");
      const groupEntries = [...groupDirectory.files.entries()];
      requireValue(groupEntries.length > 0, `${lodName}: invalid group count`);
      if (lod.files.has("NumGroups"))
        requireValue(
          integer(lod, "NumGroups") === groupEntries.length,
          `${lodName}: NumGroups mismatch`,
        );
      if (groupEntries.length > 256)
        warn(`${lodName}: groups above index 255 cannot be selected by the byte-index viewtable.`);
      if (lodIndex < levels.length - 1 && lod.files.has("maxDistanceToDisplay")) {
        const distance = integer(lod, "maxDistanceToDisplay", false);
        requireValue(
          previousDistance === undefined || distance > previousDistance,
          `${lodName}: LOD distance must increase`,
        );
        previousDistance = distance;
      } else {
        previousDistance = undefined;
      }
      const lodFaces = integer(lod, "NumFaces");
      const frameFaceCounts: number[][] = [];
      const sortOrders: number[] = [];
      for (const [name, entry] of groupEntries) {
        const label = `${lodName}/${name}`;
        requireValue(
          entry.type === 3 && entry.bytes.length >= 32,
          `${label}: truncated or mistyped render group`,
        );
        if (entry.bytes.length > 32) warn(`${label}: trailing group data is not interpreted.`);
        const data = view(entry.bytes);
        const wheel = wheelPrefixes.findIndex((prefix) => name.startsWith(prefix));
        if (wheel >= 0) {
          usedWheelKinds.add(wheel);
          if (data.getUint8(30) === 0)
            warn(
              `${label}: wheel center is recomputed by the loader; its authored pivot is not fixed.`,
            );
        }
        sortOrders.push(data.getInt8(31));
        const frameCounts: number[] = [];
        for (let frame = 0; frame < 2; frame++) {
          const values = Array.from({ length: 6 }, (_, i) =>
            data.getInt16(frame * 12 + i * 2, true),
          );
          const [firstFace, faceCount, firstVertex, vertexCount, firstNormal, normalCount] =
            values as [number, number, number, number, number, number];
          requireValue(
            values.every((value) => value >= 0),
            `${label} frame ${frame}: negative range`,
          );
          requireValue(
            firstFace + faceCount <= result.faces &&
              firstVertex + vertexCount <= result.vertices &&
              firstNormal + normalCount <= result.normals,
            `${label} frame ${frame}: range exceeds an array`,
          );
          const projectedCount = Math.ceil(vertexCount / 3) * 3;
          if (firstVertex + projectedCount > result.vertices)
            warn(
              `${label} frame ${frame}: RTPT's last triple reads beyond VertexList; enclosing allocation padding is unverified.`,
            );
          const scratch = 4 * projectedCount + 6 * normalCount;
          result.maxScratchBytes = Math.max(result.maxScratchBytes, scratch);
          requireValue(
            scratch <= 1024 - 0xe0,
            `${label} frame ${frame}: renderer scratch overflow (${scratch}/800 bytes)`,
          );
          requireValue(
            vertexCount <= 256 && normalCount <= 256,
            `${label} frame ${frame}: byte-index range exceeded`,
          );
          for (let n = firstNormal; n < firstNormal + normalCount; n++) {
            const projected = normals.getInt16(n * 8 + 6, true);
            requireValue(
              projected >= 0 && projected < vertexCount,
              `${label} frame ${frame}: normal projected vertex out of range`,
            );
          }
          for (let face = firstFace; face < firstFace + faceCount; face++) {
            const offset = face * 24;
            const degree = faces.getUint8(offset) === 0x24 ? 3 : 4;
            for (let corner = 0; corner < degree; corner++) {
              const vertex = faces.getUint8(offset + 16 + corner);
              const normal = faces.getUint8(offset + 20 + corner);
              requireValue(
                vertex < vertexCount,
                `${label} frame ${frame}: face vertex out of range`,
              );
              requireValue(
                normal < normalCount,
                `${label} frame ${frame}: face normal out of range`,
              );
              result.checkedCorners++;
              if (normals.getInt16((firstNormal + normal) * 8 + 6, true) !== vertex)
                result.representativeCorners++;
            }
          }
          frameCounts.push(faceCount);
        }
        if (entry.bytes.slice(0, 12).some((byte, i) => byte !== entry.bytes[i + 12]))
          allFramesAliased = false;
        frameFaceCounts.push(frameCounts);
      }
      if (new Set(sortOrders).size !== sortOrders.length)
        warn(
          `${lodName}: tied group sort keys make view-table identity depend on registry enumeration and the loader's tie handling.`,
        );
      const ordered = frameFaceCounts.map((counts, i) => ({ counts, sort: sortOrders[i]! }));
      // Match CarDisplayConstructor's pairwise swaps, including equal-key swaps.
      for (let j = 0; j < ordered.length - 1; j++) {
        for (let k = j + 1; k < ordered.length; k++) {
          if (ordered[k]!.sort <= ordered[j]!.sort) {
            [ordered[j], ordered[k]] = [ordered[k]!, ordered[j]!];
          }
        }
      }
      const selection = payload(lod, "viewtable", 3).bytes;
      const stride = groupEntries.length + 1;
      const rows = groupEntries.length === 1 ? 1 : 16;
      requireValue(selection.length >= rows * stride, `${lodName}: truncated viewtable`);
      for (let row = 0; row < rows; row++) {
        const visible = selection[row * stride]!;
        requireValue(visible <= groupEntries.length, `${lodName}: view row count exceeds groups`);
        const selected = [...selection.slice(row * stride + 1, row * stride + 1 + visible)];
        requireValue(
          selected.every((index) => index < groupEntries.length),
          `${lodName}: view row index out of range`,
        );
        if (new Set(selected).size !== selected.length)
          warn(`${lodName}: a view row draws a group more than once.`);
        for (let frame = 0; frame < 2; frame++) {
          const needed = selected.reduce((sum, index) => sum + ordered[index]!.counts[frame]!, 0);
          requireValue(
            needed <= lodFaces,
            `${lodName}: NumFaces understates a visible frame (${needed} > ${lodFaces})`,
          );
        }
      }
      if (lodIndex < levels.length - 1 && !lod.files.has("maxDistanceToDisplay"))
        warn(`${lodName}: LOD distance depends on class defaults outside this resource.`);
      result.groups += groupEntries.length;
    }
    if (levels.length === 1) warn("One LOD only; distance-detail authoring is absent.");
    if (allFramesAliased)
      warn("Intact and damaged frame ranges alias; separate damage art is absent.");
    if (usedWheelKinds.size < 4)
      warn(
        "Fewer than four default wheel mappings were found; custom mappings/callbacks are not evaluated.",
      );
    if (externalTextureReferences)
      warn(
        `${externalTextureReferences} texture/CLUT references lie outside car.bit; external VRAM contents are unverified.`,
      );
    if (result.representativeCorners) {
      const message = `${result.representativeCorners}/${result.checkedCorners} corners use a normal's different in-range projected vertex for reflection lookup.`;
      if (options.strictAssociations)
        result.errors.push(`Authored association fidelity: ${message}`);
      else warn(`${message} The loader permits representative positions; verify authoring intent.`);
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  result.warnings.push(...warnings);
  return result;
}

export async function validateCarMr(
  bytes: Uint8Array<ArrayBuffer>,
  options: CarDisplayOptions = {},
) {
  try {
    return validateCarDisplay((await readMr(bytes)).root, options);
  } catch (error) {
    const result = report();
    result.errors.push(`MR container: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
}

async function independentComparison(
  bytes: Uint8Array<ArrayBuffer>,
  input: string,
  referenceRoot: string,
) {
  const parsed = await readMr(bytes);
  const actual = [...parsed.directories]
    .flatMap(([path, directory]) =>
      [...directory.files].map(([name, entry]) => ({
        path: `${path}/${name}`,
        type: entry.type,
        array: entry.arraySize,
        sha: new Bun.CryptoHasher("sha256").update(entry.bytes).digest("hex"),
      })),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  const code = `import hashlib,json,sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1])/'tools'))\nfrom overlay_resources import MR\nm=MR(Path(sys.argv[2]).read_bytes())\nprint(json.dumps([{'path':'/'.join(e['parts']),'type':e['type'],'array':e['array_size'],'sha':hashlib.sha256(e['_payload']).hexdigest()} for e in m.entries]))`;
  const process = Bun.spawn([Bun.env.PYTHON ?? "python3", "-c", code, referenceRoot, input], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  requireValue(status === 0, `Independent reader failed: ${stderr.trim()}`);
  const expected = (JSON.parse(stdout) as typeof actual).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  requireValue(
    JSON.stringify(actual) === JSON.stringify(expected),
    "Independent reader disagrees on payload metadata or bytes",
  );
}

async function main(args: string[]) {
  if (args.includes("--help") || args.length === 0) {
    console.log(
      "Usage: bun tools/resources/validate-car.ts FILE [--strict-associations] [--reference-root game]",
    );
    console.log("Checks car display-resource MR structure. Warnings do not fail; errors exit 1.");
    console.log("Does not establish playable-mod completeness, runtime behavior or art quality.");
    return;
  }
  const input = args.shift()!;
  let referenceRoot: string | undefined;
  const options: CarDisplayOptions = {};
  while (args.length) {
    const option = args.shift();
    if (option === "--strict-associations") options.strictAssociations = true;
    else if (option === "--reference-root") {
      referenceRoot = args.shift();
      requireValue(referenceRoot, "--reference-root requires a path");
    } else throw new Error(`Unknown option: ${option}`);
  }
  const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
  const result = await validateCarMr(bytes, options);
  if (referenceRoot && !result.errors.length) {
    try {
      await independentComparison(bytes, resolve(input), resolve(referenceRoot));
      console.log("PASS: independent game MR reader agrees on every payload.");
    } catch (error) {
      result.errors.push(String(error));
    }
  }
  console.log(
    `${result.errors.length ? "FAIL" : "PASS"}: car display structure — ${result.lods} LODs, ${result.groups} groups, ${result.faces} stored faces, ${result.vertices} vertices, ${result.normals} normals.`,
  );
  console.log(
    `Checked ${result.checkedCorners} frame corners; maximum scratch ${result.maxScratchBytes}/800 bytes.`,
  );
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  for (const warning of result.warnings) console.log(`WARNING: ${warning}`);
  console.log(
    "UNTESTED: runtime registration, physics/collision, engine rendering, VRAM slot relocation and art quality.",
  );
  if (result.errors.length) process.exitCode = 1;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
