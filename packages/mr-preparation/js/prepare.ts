import { Preparation } from "../build/rm4_mr_preparation.js";

export function createPreparer(initialize: () => Promise<unknown>) {
  let ready: Promise<unknown> | undefined;
  return async (
    files: Map<string, Uint8Array<ArrayBuffer>>,
    modules: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  ): Promise<void> => {
    await (ready ??= initialize().catch((error) => {
      ready = undefined;
      throw error;
    }));
    const index = files.get("/DATA/files.tsv");
    if (!index) throw Error("Missing resource sector index");
    const preparation = new Preparation(new TextDecoder().decode(index));
    try {
      for (const [name, bytes] of modules) preparation.addModule(name, bytes);
      const output = new Map<string, Uint8Array<ArrayBuffer>>();
      for (const path of preparation.paths()) {
        const bytes = files.get(path);
        if (!bytes) throw Error(`Missing indexed resource ${path}`);
        const prepared = path.endsWith(".MR")
          ? (preparation.archive(bytes) as Uint8Array<ArrayBuffer>)
          : bytes;
        preparation.setSize(path, prepared.length);
        if (prepared !== bytes) output.set(path, prepared);
      }
      output.set("/DATA/files.tsv", new TextEncoder().encode(preparation.index()));
      for (const [path, bytes] of output) files.set(path, bytes);
    } finally {
      preparation.free();
    }
  };
}
