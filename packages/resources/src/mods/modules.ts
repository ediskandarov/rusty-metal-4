const sectionName = "rm4.module";
const validName = /^[a-z][a-z0-9_]{0,119}\.sym$/;

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
