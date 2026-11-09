import { expect, test } from "bun:test";

import { checkResource, checkResources, resourceRows } from "../../web/src/compatibility/index.ts";
const id = "/SCUS_945.60";
const reference = { id, size: 303104, sha256: "different-hash" };
function executable(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("PS-X EXE"));
  return bytes;
}
const check = (bytes: Uint8Array<ArrayBuffer>) =>
  checkResource({ id, bytes, reference, available: new Set([id]) });
test("different EXE code passes within the inclusive ten-percent size tolerance", async () => {
  for (const size of [272794, 303104, 333414])
    expect((await check(executable(size))).status).toBe("compatible");
  for (const size of [272793, 333415])
    expect((await check(executable(size))).status).toBe("uncompatible");
});
test("same-size garbage, truncated EXE and read failures are rejected", async () => {
  expect((await check(new Uint8Array(reference.size))).status).toBe("uncompatible");
  expect((await check(executable(2047))).status).toBe("uncompatible");
  const resources = [
    { id, size: reference.size, read: () => Promise.reject(new Error("Bad sector")) },
  ];
  const rows = resourceRows(resources, [reference]);
  await checkResources(resources, rows, new AbortController().signal, () => {});
  expect(rows[0]?.status).toBe("uncompatible");
});
