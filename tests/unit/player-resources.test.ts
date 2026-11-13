import { expect, test } from "bun:test";

import { createResourcesStore } from "../../apps/player/src/state/resources.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function finish(store: ReturnType<typeof createResourcesStore>) {
  for (let i = 0; i < 100; ++i) {
    if (store.getState().phase !== "checking") return;
    await Bun.sleep(1);
  }
  throw new Error("Resource checks did not settle");
}

test("resource checks publish immutable snapshots and preserve discovery notices", async () => {
  const read = deferred<Uint8Array<ArrayBuffer>>();
  const store = createResourcesStore(() =>
    Promise.resolve({
      resources: [{ id: "/TEST.IMG", size: 1, read: () => read.promise }],
      notices: ["Optional track absent"],
    }),
  );
  await store.getState().inspect(new Map());
  const checking = store.getState();
  expect(checking.phase).toBe("checking");
  expect(checking.rows.find((row) => row.id === "/TEST.IMG")?.status).toBe("checking");
  read.resolve(new Uint8Array([1]));
  await finish(store);
  expect(store.getState().phase).toBe("complete");
  expect(store.getState().rows.find((row) => row.id === "/TEST.IMG")?.status).toBe("warning");
  expect(checking.rows.find((row) => row.id === "/TEST.IMG")?.status).toBe("checking");
  expect(store.getState().notices).toEqual(["Optional track absent"]);
});

test("pause and immediate resume ignore a late result from the aborted read", async () => {
  const old = deferred<Uint8Array<ArrayBuffer>>();
  let reads = 0;
  const store = createResourcesStore(() =>
    Promise.resolve({
      resources: [
        {
          id: "/TEST.IMG",
          size: 1,
          read: () => (++reads === 1 ? old.promise : Promise.resolve(new Uint8Array([1]))),
        },
      ],
      notices: [],
    }),
  );
  await store.getState().inspect(new Map());
  store.getState().pause();
  expect(store.getState().phase).toBe("paused");
  expect(store.getState().rows.find((row) => row.id === "/TEST.IMG")?.status).toBe("pending");
  store.getState().resume();
  store.getState().resume();
  await finish(store);
  const completed = store.getState();
  old.reject(new Error("Late aborted read"));
  await Bun.sleep(5);
  expect(store.getState()).toBe(completed);
  expect(reads).toBe(2);
});

test("selecting a new disc discards stale discovery, errors and filters", async () => {
  const old = deferred<{ resources: []; notices: string[] }>();
  let discoveries = 0;
  const store = createResourcesStore(() =>
    ++discoveries === 1 ? old.promise : Promise.resolve({ resources: [], notices: ["New disc"] }),
  );
  const pending = store.getState().inspect(new Map());
  store.getState().setQuery("old");
  store.getState().setIssuesOnly(true);
  await store.getState().inspect(new Map());
  await finish(store);
  const current = store.getState();
  old.resolve({ resources: [], notices: ["Old disc"] });
  await pending;
  expect(store.getState()).toBe(current);
  expect(current.query).toBe("");
  expect(current.issuesOnly).toBe(false);
  expect(current.notices).toEqual(["New disc"]);
});

test("an old check cannot alter the replacement disc", async () => {
  const old = deferred<Uint8Array<ArrayBuffer>>();
  let discoveries = 0;
  const store = createResourcesStore(() =>
    Promise.resolve({
      resources: ++discoveries === 1 ? [{ id: "/OLD.IMG", size: 1, read: () => old.promise }] : [],
      notices: [],
    }),
  );
  await store.getState().inspect(new Map());
  await store.getState().inspect(new Map());
  await finish(store);
  const current = store.getState();
  old.resolve(new Uint8Array([1]));
  await Bun.sleep(5);
  expect(store.getState()).toBe(current);
  expect(current.rows.some((row) => row.id === "/OLD.IMG")).toBe(false);
});

test("discovery failure is visible and a new disc clears it", async () => {
  let discoveries = 0;
  const store = createResourcesStore(() => {
    if (++discoveries === 1) return Promise.reject(new Error("Unreadable disc"));
    return Promise.resolve({ resources: [], notices: [] });
  });
  await store.getState().inspect(new Map());
  expect(store.getState().phase).toBe("failed");
  expect(store.getState().error).toBe("Unreadable disc");
  store.getState().resume();
  expect(discoveries).toBe(1);
  await store.getState().inspect(new Map());
  await finish(store);
  expect(store.getState().error).toBeNull();
});
