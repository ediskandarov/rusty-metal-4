import { createStore } from "zustand/vanilla";

import { maxModBytes, type ModManifest, type ModPackage, readMod, resolveMods } from "./package.ts";

interface Release {
  digest: string;
  manifest: ModManifest;
  size: number;
}

interface Library {
  releases: Release[];
  enabled: string[];
}

export function sessionReleases(state: Library) {
  const releases = resolveMods(state.releases, state.enabled);
  if (releases.reduce((bytes, release) => bytes + release.size, 0) > maxModBytes)
    throw Error("The enabled mods exceed the session size limit");
  return releases;
}

const empty: Library = { releases: [], enabled: [] };
const database = "rm4-mod-library";
let changes: BroadcastChannel | undefined;

function libraryChanges() {
  if (typeof BroadcastChannel === "undefined") return;
  return (changes ??= new BroadcastChannel(database));
}

function openLibrary(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("library");
      request.result.createObjectStore("packages");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error("Could not open the mod library"));
  });
}

// Read metadata and pin the corresponding Blobs in the same transaction.
async function transact<T>(
  mode: IDBTransactionMode,
  action: (
    state: Library,
    metadata: IDBObjectStore,
    files: IDBObjectStore,
    result: (value: T) => void,
  ) => void,
): Promise<T> {
  const db = await openLibrary();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(["library", "packages"], mode);
      const metadata = tx.objectStore("library");
      const files = tx.objectStore("packages");
      let result: T;
      let failure: Error | undefined;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? Error("Could not access the mod library"));
      const request = metadata.get("state");
      request.onsuccess = () => {
        try {
          action((request.result as Library | undefined) ?? empty, metadata, files, (value) => {
            result = value;
          });
        } catch (error) {
          failure = error instanceof Error ? error : Error(String(error));
          tx.abort();
        }
      };
    });
  } finally {
    db.close();
  }
}

export function loadLibrary() {
  return transact<Library>("readonly", (state, _, __, done) => done(state));
}

function editLibrary(update: (state: Library, files: IDBObjectStore) => Library) {
  return transact<void>("readwrite", (state, metadata, files) => {
    const updated = update(state, files);
    sessionReleases(updated);
    metadata.put(updated, "state");
  }).then(() => {
    libraryChanges()?.postMessage(null);
  });
}

export async function installMod(file: Blob, enable = false, signal?: AbortSignal) {
  if (file.size > maxModBytes) throw Error("Mod package is too large");
  const { manifest, digest } = await readMod(new Uint8Array(await file.arrayBuffer()));
  signal?.throwIfAborted();
  await editLibrary((state, files) => {
    signal?.throwIfAborted();
    const exists = state.releases.some((release) => release.digest === digest);
    const releases = exists
      ? state.releases
      : [...state.releases, { manifest, digest, size: file.size }];
    if (!exists) files.add(file, digest);
    const enabled = enable
      ? [
          ...state.enabled.filter(
            (ref) =>
              state.releases.find((release) => release.digest === ref)?.manifest.id !== manifest.id,
          ),
          digest,
        ]
      : state.enabled;
    return { releases, enabled };
  });
  return digest;
}

export function setModEnabled(digest: string, enabled: boolean) {
  return editLibrary((state) => {
    const release = state.releases.find((item) => item.digest === digest);
    if (!release) throw Error("This release is no longer installed");
    const selected = state.enabled.filter((ref) => {
      if (ref === digest) return false;
      return (
        !enabled ||
        state.releases.find((item) => item.digest === ref)?.manifest.id !== release.manifest.id
      );
    });
    return { ...state, enabled: enabled ? [...selected, digest] : selected };
  });
}

export function removeMod(digest: string) {
  return editLibrary((state, files) => {
    files.delete(digest);
    return {
      releases: state.releases.filter((release) => release.digest !== digest),
      enabled: state.enabled.filter((ref) => ref !== digest),
    };
  });
}

export async function loadEnabledMods(): Promise<ModPackage[]> {
  const selected = await transact<Array<{ digest: string; file?: Blob }>>(
    "readonly",
    (state, _, files, done) => {
      const entries = sessionReleases(state).map(({ digest }) => {
        const entry: { digest: string; file?: Blob } = { digest };
        const request = files.get(digest);
        request.onsuccess = () => {
          entry.file = request.result as Blob | undefined;
        };
        return entry;
      });
      done(entries);
    },
  );
  const mods = [];
  for (const { digest, file } of selected) {
    if (!file) throw Error("An enabled mod is missing from storage");
    const release = await readMod(new Uint8Array(await file.arrayBuffer()));
    if (release.digest !== digest) throw Error("An enabled mod no longer matches its installation");
    mods.push(release);
  }
  return mods;
}

export function createModLibraryStore() {
  const store = createStore(() => ({
    library: empty,
    status: "Loading mods…",
    error: "",
    busy: true,
  }));
  let revision = 0;
  async function refresh() {
    const reading = ++revision;
    try {
      const library = await loadLibrary();
      if (reading === revision) store.setState({ library, status: "" });
    } catch (error) {
      if (reading === revision) store.setState({ status: "", error: String(error) });
    }
  }
  libraryChanges()?.addEventListener("message", () => void refresh());
  void refresh().finally(() => store.setState({ busy: false }));
  return Object.assign(store, {
    async run(action: () => Promise<unknown>) {
      if (store.getState().busy) return;
      store.setState({ busy: true, error: "" });
      try {
        await action();
        await refresh();
      } catch (error) {
        store.setState({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        store.setState({ busy: false, status: "" });
      }
    },
  });
}
