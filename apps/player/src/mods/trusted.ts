import { sha256 } from "@tm4/mods";
import { loadTm3Converter } from "@tm4/mods/recipe";

export async function loadApprovedModModules(runtime: string) {
  const converter = await loadTm3Converter(location.origin);
  if (!converter || converter.release.runtime !== runtime) return undefined;
  const { directory, release } = converter;
  return new Map(
    await Promise.all(
      release.files
        .filter(({ path }) => path.startsWith("modules/"))
        .map(async ({ path, sha256: expected }) => {
          const response = await fetch(new URL(path, directory));
          if (!response.ok) throw Error(`Could not load approved resource module ${path}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if ((await sha256(bytes)) !== expected)
            throw Error(`Incorrect approved resource module ${path}`);
          return [path.slice("modules/".length).replace(/\.wasm$/, ".sym"), bytes] as const;
        }),
    ),
  );
}
