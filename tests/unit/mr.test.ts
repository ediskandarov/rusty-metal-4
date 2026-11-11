import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import { checkResource, readMr } from "@tm4/resources/compatibility";

function join(...parts: Uint8Array<ArrayBuffer>[]) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function name(value: string) {
  const bytes = new Uint8Array((value.length + 4) & ~3);
  bytes.set(new TextEncoder().encode(value));
  return bytes;
}
function file(value: Uint8Array<ArrayBuffer>, compressed = false, label = "value") {
  const key = name(label);
  const data = compressed ? join(new Uint8Array(deflateSync(value)), new Uint8Array(3)) : value;
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  header[0] = key.length;
  header[1] = 22;
  view.setUint16(2, 2, true);
  view.setUint32(4, data.length, true);
  view.setUint32(8, compressed ? value.length : 0, true);
  return join(header, key, data);
}
function directory(
  files: Uint8Array<ArrayBuffer>[] = [],
  children: Uint8Array<ArrayBuffer>[] = [],
) {
  const header = new Uint8Array(4);
  header[0] = 8;
  header[1] = children.length;
  new DataView(header.buffer).setUint16(2, files.length, true);
  return join(header, name("Root"), ...files, ...children);
}
const archive = (root: Uint8Array<ArrayBuffer>) =>
  join(new Uint8Array([0x67, 0, 0xcc, 0xcc]), root);
const data = new Uint8Array([11, 22, 33, 44]);

test("MR parses directories, entry metadata and aligned compressed payloads", async () => {
  const root = directory([file(data)], [directory([file(data, true)])]);
  const parsed = await readMr(archive(root));
  expect(parsed.rootName).toBe("Root");
  expect(parsed.root.files.get("value")).toEqual({ type: 22, arraySize: 2, bytes: data });
  expect(parsed.directories.get("Root/Root")?.files.get("value")?.bytes).toEqual(data);
  const alternate = archive(directory());
  alternate[2] = alternate[3] = 0;
  expect((await readMr(alternate)).root.files.size).toBe(0);
});
test("MR rejects truncated names, headers, payloads and corrupt compressed streams", async () => {
  const bytes = archive(directory([file(data)]));
  for (const length of [0, 3, 7, 12, 25, bytes.length - 1])
    await expect(readMr(bytes.subarray(0, length))).rejects.toThrow();
  const badName = bytes.slice();
  badName[4] = 3;
  await expect(readMr(badName)).rejects.toThrow("name length");
  const badPayload = bytes.slice();
  new DataView(badPayload.buffer).setUint32(20, 0xffffffff, true);
  await expect(readMr(badPayload)).rejects.toThrow();
  const compressed = archive(directory([file(data, true)]));
  compressed[36] = 0;
  await expect(readMr(compressed)).rejects.toThrow();
});
test("MR rejects duplicate entries, duplicate directories, excess nesting and trailing data", async () => {
  await expect(readMr(archive(directory([file(data), file(data)])))).rejects.toThrow(
    "Duplicate MR entry",
  );
  await expect(readMr(archive(directory([], [directory(), directory()])))).rejects.toThrow(
    "Duplicate MR directory",
  );
  let root = directory();
  for (let i = 0; i < 66; i++) root = directory([], [root]);
  await expect(readMr(archive(root))).rejects.toThrow("nesting limit");
  await expect(readMr(join(archive(directory()), new Uint8Array([1])))).rejects.toThrow(
    "Unexpected data",
  );
  await readMr(join(archive(directory()), new Uint8Array([0, 0xcc, 0xcd, 0xfd])));
});
test("generic MR compatibility accepts changed payloads without depending on reference hashes", async () => {
  const id = "/DATA/CAR.MR";
  const context = {
    id,
    available: new Set([id]),
    reference: { id, size: 999, sha256: "not-used" },
  };
  for (const payload of [data, new Uint8Array([88, 99, 0, 1])])
    expect(
      (await checkResource({ ...context, bytes: archive(directory([file(payload, true)])) }))
        .status,
    ).toBe("compatible");
  const broken = new Uint8Array([1, 2, 3, 4]);
  expect((await checkResource({ ...context, bytes: broken })).status).toBe("uncompatible");
});
test("MR checks remain cancellable", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(readMr(archive(directory([file(data, true)])), controller.signal)).rejects.toThrow();
});
