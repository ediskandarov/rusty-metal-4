import { rewriteMrEntries } from "../compatibility/mr.ts";

const sectionName = "rm4.module";
const validName = /^[a-z][a-z0-9_]{0,119}\.sym$/;
const magic = [0, 97, 115, 109, 1, 0, 0, 0];
export const isWasm = (bytes: Uint8Array) => magic.every((value, i) => bytes[i] === value);

export function moduleName(bytes: Uint8Array<ArrayBuffer>): string {
  const sections = WebAssembly.Module.customSections(new WebAssembly.Module(bytes), sectionName);
  if (sections.length !== 1) throw Error("Wasm must have one rm4.module identity section");
  const name = new TextDecoder("utf-8", { fatal: true }).decode(sections[0]);
  if (!validName.test(name)) throw Error("Invalid Wasm module identity");
  return name;
}

export function nameModule(bytes: Uint8Array<ArrayBuffer>, name: string): Uint8Array<ArrayBuffer> {
  if (!validName.test(name)) throw Error("Invalid Wasm module identity");
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.customSections(module, sectionName).length)
    throw Error("Wasm already has a module identity");
  const encode = new TextEncoder();
  const key = encode.encode(sectionName),
    value = encode.encode(name);
  const leb = (number: number) => {
    const out = [];
    do {
      const byte = number & 127;
      number >>>= 7;
      out.push(byte | (number ? 128 : 0));
    } while (number);
    return out;
  };
  const body = [...leb(key.length), ...key, ...value];
  const tail = new Uint8Array([0, ...leb(body.length), ...body]);
  const output = new Uint8Array(bytes.length + tail.length);
  output.set(bytes);
  output.set(tail, bytes.length);
  return output;
}

export function originalModuleName(bytes: Uint8Array<ArrayBuffer>): string {
  if (bytes.length < 20) throw Error("Truncated MIPS module descriptor");
  const offset = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16, true);
  const end = bytes.indexOf(42, offset);
  if (offset < 20 || end < offset || end - offset > 124) throw Error("Invalid MIPS module name");
  const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
  if (!validName.test(name)) throw Error("Invalid MIPS module name");
  return name;
}

// Convert disc code before runtime startup; already-authored Wasm stays inside its MR.
export async function prepareModuleResources(
  files: Map<string, Uint8Array<ArrayBuffer>>,
  modules: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
): Promise<void> {
  const output = new Map(files);
  const images = new Map(modules);
  for (const [name, bytes] of images)
    if (moduleName(bytes) !== name) throw Error(`Module identity mismatch: ${name}`);
  for (const [path, bytes] of files) {
    if (!/\.MR$/i.test(path)) continue;
    const prepared = await rewriteMrEntries(bytes, (_, entry) => {
      if (entry.type !== 6) return entry;
      if (isWasm(entry.bytes)) {
        const name = moduleName(entry.bytes),
          previous = images.get(name);
        if (
          previous &&
          (previous.length !== entry.bytes.length ||
            previous.some((byte, i) => byte !== entry.bytes[i]))
        )
          throw Error(`Conflicting module identity: ${name}`);
        images.set(name, entry.bytes);
        return entry;
      }
      const name = originalModuleName(entry.bytes);
      // Movie playback belongs to the browser runtime, not a resource module.
      if (name === "movie_r.sym") return null;
      const wasm = images.get(name);
      if (!wasm) throw Error(`Missing resource module ${name}`);
      return { ...entry, bytes: wasm };
    });
    output.set(path, prepared);
  }
  const index = files.get("/DATA/files.tsv");
  if (!index) throw Error("Missing resource sector index");
  let sector = 1;
  const rows = new TextDecoder()
    .decode(index)
    .trim()
    .split("\n")
    .map((row) => {
      const fields = row.split("\t");
      if (fields.length !== 3) throw Error("Invalid resource sector index");
      const path = fields[2]!,
        bytes = output.get(path.toUpperCase());
      if (!bytes) throw Error(`Missing indexed resource ${path}`);
      const rowText = `${sector}\t${bytes.length}\t${path}`;
      sector += Math.max(1, Math.ceil(bytes.length / 2048));
      return rowText;
    });
  output.set("/DATA/files.tsv", new TextEncoder().encode(rows.join("\n") + "\n"));
  for (const [path, bytes] of output) files.set(path, bytes);
}
