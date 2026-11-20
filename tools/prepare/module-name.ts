import { nameModule } from "../../packages/resources/src/mods/modules.ts";
const [path, name] = process.argv.slice(2);
if (!path || !name) throw Error("Supply Wasm file and module identity");
await Bun.write(path, nameModule(new Uint8Array(await Bun.file(path).arrayBuffer()), name));
