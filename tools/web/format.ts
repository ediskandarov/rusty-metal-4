import { format, type Options } from "prettier";

import { root } from "../common.js";

const configuration = Bun.TOML.parse(await Bun.file(`${root}/bunfig.toml`).text()) as {
  fmt: Options & { sortImports?: boolean };
};
const options = { ...configuration.fmt };
delete options.sortImports;
const check = process.argv.includes("--check");
let changed = 0;
for await (const path of new Bun.Glob("apps/*/src/**/*.astro").scan({ cwd: root })) {
  const file = Bun.file(`${root}/${path}`);
  const source = await file.text();
  const formatted = await format(source, {
    ...options,
    parser: "astro",
    plugins: ["prettier-plugin-astro"],
  });
  if (source === formatted) continue;
  changed++;
  console.log(path);
  if (!check) await Bun.write(file, formatted);
}
if (check && changed) throw new Error(`${changed} Astro files need formatting`);
