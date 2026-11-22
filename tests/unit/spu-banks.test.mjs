import { test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { $ } from "bun";

test("extra sample banks produce the same looping PCM and release their voices", async () => {
  const root = resolve(import.meta.dir, "../..");
  const temp = await mkdtemp(join(tmpdir(), "rm4-spu-banks-"));
  try {
    const mixer = join(temp, "psyz_spu.c");
    const check = join(temp, "check");
    await $`patch --batch --fuzz=0 -o ${mixer} external/psyz/psyz/src/psyz/psyz_spu.c port/psyz/patches/spu-sample-banks.patch`
      .cwd(root)
      .quiet();
    await $`cc -std=gnu11 -fsanitize=address -fno-omit-frame-pointer -D__psyz -DPSYZ_LOG_LEVEL=4 -Iexternal/psyz/psyz/include -Iexternal/psyz/psyz/src -Iexternal/psyz/psyz/src/psyz -Iexternal/psyz/decomp/src/libspu -Iport/psyz tests/native/check_spu_banks.c ${mixer} -o ${check}`
      .cwd(root)
      .quiet();
    await $`${check}`;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
