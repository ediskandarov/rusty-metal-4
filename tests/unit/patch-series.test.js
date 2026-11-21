import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPatchSeries } from "../../tools/prepare/patches.js";

test("patch series preserves explicit dependency order and rejects incomplete inventories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rm4-patches-"));
  try {
    for (const name of ["base", "adjustment"])
      await Bun.write(join(directory, `${name}.patch`), "fixture");
    const series = join(directory, "series");
    await Bun.write(
      series,
      "# Base must precede its adjustment.\r\nbase.patch\r\n\r\nadjustment.patch\r\n",
    );
    expect(await readPatchSeries(directory)).toEqual(["base.patch", "adjustment.patch"]);
    for (const [contents, error] of [
      ["base.patch\n", "Patches missing from"],
      ["base.patch\nbase.patch\nadjustment.patch\n", "Duplicate patch"],
      ["base.patch\nadjustment.patch\nabsent.patch\n", "Missing patch listed"],
      ["../base.patch\nadjustment.patch\n", "Invalid patch name"],
    ]) {
      await Bun.write(series, contents);
      await expect(readPatchSeries(directory)).rejects.toThrow(error);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
