import { expect, test } from "bun:test";

import {
  checkResource,
  checkResources,
  compatibilityReport,
  requireResources,
  resourceRows,
} from "@tm4/resources/compatibility";

function video() {
  const bytes = new Uint8Array(2352);
  bytes.fill(255, 1, 11);
  bytes[15] = 2;
  const view = new DataView(bytes.buffer);
  view.setUint16(24, 0x160, true);
  view.setUint16(26, 0x8001, true);
  view.setUint16(30, 1, true);
  view.setUint32(32, 1, true);
  view.setUint32(36, 32, true);
  view.setUint16(40, 320, true);
  view.setUint16(42, 240, true);
  return bytes;
}
const id = "/MOVIE/INTRO.STR";
const reference = { id, size: 2352, sha256: "not-used" };
const check = (bytes: Uint8Array<ArrayBuffer>) =>
  checkResource({ id, bytes, reference, available: new Set([id]) });

test("STR compatibility does not depend on content hash", async () => {
  const bytes = video();
  expect((await check(bytes)).status).toBe("compatible");
  bytes[90] = 42;
  expect((await check(bytes)).status).toBe("compatible");
});
test("missing video is optional and failed reads warn without blocking", async () => {
  expect(() => requireResources([], [reference])).not.toThrow();
  expect(compatibilityReport(resourceRows([], [reference])).status).toBe("compatible");
  const resources = [{ id, size: 2352, read: () => Promise.reject(new Error("Missing video")) }];
  const rows = resourceRows(resources, [reference]);
  await checkResources(resources, rows, new AbortController().signal, () => {});
  expect(compatibilityReport(rows).status).toBe("warning");
});
test("STR malformed headers, unsupported size, missing chunks and empty streams warn", async () => {
  for (const bytes of [new Uint8Array(), video().subarray(0, 100)])
    expect((await check(bytes)).status).toBe("warning");
  for (const offset of [0, 15, 16, 24, 28, 30, 32, 40, 42]) {
    const bytes = video();
    bytes[offset] = 99;
    expect((await check(bytes)).status).toBe("warning");
  }
});
test("cancelled video checks propagate cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    checkResource({ id, bytes: video(), available: new Set([id]), signal: controller.signal }),
  ).rejects.toThrow();
});
