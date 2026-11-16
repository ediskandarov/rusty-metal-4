import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { root } from "../../../tools/common.js";

const source = join(root, "tests/emscripten/dlsym-catchup");
const temporary = await mkdtemp(join(tmpdir(), "rm4-dlsym-catchup-"));
try {
  for (const [name, value] of [
    ["first", 1],
    ["second", 2],
  ]) {
    await $`emcc ${join(source, "side.c")} -DVALUE=${value} -pthread -sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS=_answer -o ${name + ".wasm"}`.cwd(
      temporary,
    );
  }
  await $`emcc ${join(source, "main.c")} -pthread -sMAIN_MODULE=2 -sASYNCIFY -sPTHREAD_POOL_SIZE=1 --embed-file first.wasm --embed-file second.wasm --js-library ${join(root, "port/emscripten/dylink.js")} -o check.cjs`.cwd(
    temporary,
  );
  // An abort in a worker can exit with status zero. Require the completion marker too.
  const result = await $`node check.cjs`.cwd(temporary).quiet();
  const output = result.stdout.toString() + result.stderr.toString();
  assert.doesNotMatch(output, /Aborted|RuntimeError/);
  assert.match(output, /PASS: dlsym catch-up called the second module on both threads/);
  console.log(result.stdout.toString().trim());
} finally {
  await rm(temporary, { recursive: true, force: true });
}
