import { expect, test } from "bun:test";

import {
  journalRetentionMs,
  type JournalStorage,
  ServerJournal,
} from "../../apps/rustymetal4.com/src/worker/journal.ts";

function storage() {
  const map = new Map<string, unknown>();
  const api = {
    get: async (k: string) => structuredClone(map.get(k)),
    put: async (k: string, v: unknown) => {
      map.set(k, structuredClone(v));
    },
    delete: async (keys: string | string[]) => {
      for (const k of typeof keys === "string" ? [keys] : keys) map.delete(k);
    },
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(api),
  };
  return { map, api: api as unknown as JournalStorage };
}
function response(size: number) {
  const bytes = new Uint8Array(size).fill(42);
  bytes.set(new TextEncoder().encode("TM4JRNL"));
  bytes[7] = 1;
  return new Response(bytes, { headers: { "Content-Length": String(size) } });
}
test("archive grows across chunks, survives recreation and expires", async () => {
  const { api, map } = storage();
  let archive = new ServerJournal(api);
  await archive.save(response(70000));
  await archive.save(response(150000));
  archive = new ServerJournal(api);
  const download = await archive.download();
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(
    new Uint8Array(await response(150000).arrayBuffer()),
  );
  expect(map.size).toBe(4);
  await archive.expire(Date.now() + journalRetentionMs + 1);
  expect((await archive.download()).status).toBe(404);
  expect(map.size).toBe(0);
});
test("invalid, shortened and oversized responses preserve previous journal", async () => {
  const { api } = storage();
  const archive = new ServerJournal(api);
  await archive.save(response(64));
  await expect(archive.save(response(32))).rejects.toThrow("shrank");
  await expect(
    archive.save(new Response("bad", { headers: { "content-length": "80" } })),
  ).rejects.toThrow("Invalid");
  await expect(
    archive.save(new Response("bad", { headers: { "content-length": "999999999" } })),
  ).rejects.toThrow("limit");
  expect((await archive.download()).headers.get("content-length")).toBe("64");
});
