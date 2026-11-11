import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { json, write } from "../../tools/common.js";

test("generated files retain their timestamp until their contents change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tm4-generated-"));
  try {
    const path = join(directory, "nested", "value.json");
    await write(path, '{"value":1}\n');
    expect(await json(path)).toEqual({ value: 1 });
    const timestamp = new Date("2000-01-01T00:00:00Z");
    await utimes(path, timestamp, timestamp);
    await write(path, '{"value":1}\n');
    expect((await stat(path)).mtimeMs).toBe(timestamp.getTime());
    await write(path, '{"value":2}\n');
    expect(await json(path)).toEqual({ value: 2 });
    expect((await stat(path)).mtimeMs).not.toBe(timestamp.getTime());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
