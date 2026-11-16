import { basename } from "node:path";
import { parseArgs } from "node:util";

import { runCli, UsageError } from "../cli.js";
import { write } from "../common.js";

await runCli(async () => {
  const { positionals } = parseArgs({ strict: true, allowPositionals: true });
  const [output, ...paths] = positionals;
  if (!output || !paths.length)
    throw new UsageError("Supply output response file and resource modules");
  const imports = new Set();
  for (const path of paths) {
    const module = new WebAssembly.Module(await Bun.file(path).arrayBuffer());
    const dependencies = WebAssembly.Module.imports(module);
    if (
      basename(path) !== "menu.wasm" &&
      [...dependencies, ...WebAssembly.Module.exports(module)].some(({ name }) =>
        /asyncify/i.test(name),
      )
    )
      throw new Error(`Simulation modules must not use Asyncify: ${path}`);
    for (const entry of dependencies) {
      if ((entry.kind === "function" && entry.module === "env") || entry.module === "GOT.mem")
        imports.add(entry.name);
    }
  }
  await write(
    output,
    [...imports]
      .sort()
      .map((name) => "-Wl,--export=" + name)
      .join("\n") + "\n",
  );
});
