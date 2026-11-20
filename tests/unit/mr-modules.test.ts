import { expect, test } from "bun:test";

import { readMr, rewriteMrEntries } from "../../packages/resources/src/compatibility/mr.ts";
import {
  moduleName,
  nameModule,
  prepareModuleResources,
} from "../../packages/resources/src/mods/modules.ts";
import { binary, directory, writeMr } from "../../packages/resources/src/mods/mr-writer.ts";
const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
function original(name: string) {
  const bytes = new Uint8Array(20 + name.length + 1);
  new DataView(bytes.buffer).setUint32(16, 20, true);
  bytes.set(new TextEncoder().encode(name + "*"), 20);
  return { ...binary(bytes), type: 6 };
}
function files(archive: Uint8Array<ArrayBuffer>) {
  return new Map([
    ["/DATA/MAIN.MR", archive],
    ["/DATA/files.tsv", new TextEncoder().encode(`100\t${archive.length}\t/DATA/MAIN.MR\n`)],
  ]);
}
test("Wasm identity is explicit and rejects ambiguous names", () => {
  const bytes = nameModule(empty, "mprobe.sym");
  expect(moduleName(bytes)).toBe("mprobe.sym");
  expect(() => nameModule(bytes, "second.sym")).toThrow("already");
  expect(() => moduleName(empty)).toThrow("one");
  expect(() => nameModule(empty, "../evil.sym")).toThrow("identity");
  const duplicate = new Uint8Array([...bytes, ...bytes.slice(8)]);
  expect(() => moduleName(duplicate)).toThrow("one");
});
test("stock and authored modules end up as Wasm in MR without changing other records", async () => {
  const root = directory();
  root.files.set("stock.mod", original("o_car.sym"));
  root.files.set("movie.mod", original("movie_r.sym"));
  const authored = nameModule(empty, "mprobe.sym");
  root.files.set("behavior.mod", { ...binary(authored), type: 6 });
  root.files.set("opaque", binary(new Uint8Array([7, 6, 5, 4])));
  const source = writeMr(root);
  // Original resources contain byte-valued names; retain them, not UTF-8 re-encodings.
  const nameOffset = source.findIndex(
    (_, i) => new TextDecoder().decode(source.subarray(i, i + 6)) === "opaque",
  );
  source[nameOffset + 1] = 0x85;
  expect(await rewriteMrEntries(source, (_, entry) => entry)).toEqual(source);
  const assets = files(source),
    stock = nameModule(empty, "o_car.sym");
  await prepareModuleResources(assets, new Map([["o_car.sym", stock]]));
  const result = await readMr(assets.get("/DATA/MAIN.MR")!);
  expect(result.root.files.get("stock.mod")!.bytes).toEqual(stock);
  expect(result.root.files.get("behavior.mod")!.bytes).toEqual(authored);
  expect(result.root.files.has("movie.mod")).toBe(false);
  expect(result.root.files.get("o\x85aque")!.bytes).toEqual(new Uint8Array([7, 6, 5, 4]));
  expect(new TextDecoder().decode(assets.get("/DATA/files.tsv"))).toBe(
    `1\t${assets.get("/DATA/MAIN.MR")!.length}\t/DATA/MAIN.MR\n`,
  );
});
test("missing stock modules fail during preparation", async () => {
  const root = directory();
  root.files.set("code.mod", original("o_car.sym"));
  await expect(prepareModuleResources(files(writeMr(root)), new Map())).rejects.toThrow(
    "Missing resource module",
  );
});
test("a preparation failure leaves the input assets intact", async () => {
  const root = directory();
  root.files.set("code.mod", original("o_car.sym"));
  const source = writeMr(root),
    assets = files(source);
  const bad = directory();
  bad.files.set("bad.mod", original("unknown.sym"));
  assets.set("/DATA/SECOND.MR", writeMr(bad));
  const before = new Map(assets);
  await expect(
    prepareModuleResources(assets, new Map([["o_car.sym", nameModule(empty, "o_car.sym")]])),
  ).rejects.toThrow("unknown.sym");
  expect(assets).toEqual(before);
});
