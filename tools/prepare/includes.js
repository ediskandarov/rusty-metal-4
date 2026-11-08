import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildPath, options, write } from "../common.js";
const { sdk, output: requested } = options(["sdk", "output"]);
const output = await buildPath(requested);
const aliases = {};
for (const name of await readdir(sdk)) {
  if (name.endsWith(".h"))
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
