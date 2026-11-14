import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { Glob } from "bun";

import { runCli, UsageError } from "../cli.js";
import { buildPath, write } from "../common.js";
await runCli(async () => {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
      sdk: { type: "string" },
      output: { type: "string" },
    },
  });
  if (values.help) {
    console.log("Usage: bun tools/prepare/includes.js --sdk PATH --output PATH");
    return;
  }
  if (!values["sdk"] || !values["output"])
    throw new UsageError("bun tools/prepare/includes.js --sdk PATH --output PATH");
  const { sdk, output: requested } = values;
  const output = await buildPath(requested);
  const aliases = {};
  for await (const name of new Glob("*.h").scan({ cwd: sdk, dot: true })) {
    aliases[name.toUpperCase()] = `#include ${JSON.stringify(resolve(sdk, name))}\n`;
  }
  if (!aliases["LIBGTE.H"]) throw new Error("SDK must contain libgte.h");
  for (const name of [
    "assert.h",
    "ctype.h",
    "errno.h",
    "float.h",
    "limits.h",
    "math.h",
    "setjmp.h",
    "signal.h",
    "stdarg.h",
    "stddef.h",
    "stdint.h",
    "stdio.h",
    "stdlib.h",
    "string.h",
    "strings.h",
    "time.h",
    "sys/types.h",
  ]) {
    aliases[name.toUpperCase()] = `#include_next <${name}>\n`;
  }
  Object.assign(aliases, {
    "RAND.H": "#include <stdlib.h>\n",
    "STRINGS.H": "#include <string.h>\n#include_next <strings.h>\n",
    "MEMORY.H": "#include <string.h>\n#include <strings.h>\n",
    "INLINE_C.H": "#include <LIBGTE.H>\n",
    "GTEMAC.H": "#include <LIBGTE.H>\n",
  });
  for (const [name, content] of Object.entries(aliases)) await write(join(output, name), content);
});
