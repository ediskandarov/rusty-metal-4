import { type CarMod, maxCarMods, maxModBytes, readCarMod } from "@tm4/resources/mods/package";
import { createStore } from "zustand/vanilla";

import { savedPackages, savePackages } from "../mods/storage.ts";

interface ModsState {
  selected: readonly CarMod[];
  active: readonly CarMod[];
  operation: "restoring" | "saving" | "idle";
  session: "idle" | "starting" | "running";
  error: string | null;
  addFiles: (files: readonly File[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
  beginSession: () => Promise<CarMod[]>;
  finishStartup: (started: boolean) => void;
}

export function modsLocked(state: ModsState) {
  return state.operation !== "idle" || state.session === "starting";
}

export function modsNeedRestart(state: ModsState) {
  return (
    state.session === "running" &&
    (state.selected.length !== state.active.length ||
      state.selected.some((mod, index) => {
        const active = state.active[index]!;
        return (
          mod !== active &&
          (mod.bytes.length !== active.bytes.length ||
            !mod.bytes.every((byte, offset) => byte === active.bytes[offset]))
        );
      }))
  );
}

export function modsMessage(state: ModsState) {
  if (state.error) return state.error;
  if (state.operation === "restoring") return "Restoring saved mods…";
  if (state.operation === "saving") return "Checking and saving mods…";
  if (state.session === "starting") return "Mods selected for this session.";
  if (state.session === "running") {
    if (modsNeedRestart(state))
      return `${state.active.length} mod(s) active. Saved for the next session. Restart to apply; select your disc folder again if asked.`;
    return state.active.length ? `${state.active.length} mod(s) active.` : "";
  }
  return state.selected.length ? "Mods ready. Select your disc folder to start." : "";
}

function validateSelection(mods: readonly CarMod[]) {
  if (mods.length > maxCarMods) throw new Error(`At most ${maxCarMods} mods per session`);
  if (new Set(mods.map((mod) => mod.manifest.id)).size !== mods.length)
    throw new Error("Two saved mods use the same id");
  if (new Set(mods.map((mod) => mod.manifest.name.toLowerCase())).size !== mods.length)
    throw new Error("Two mods use the same car name");
}

export function createModsStore({
  load = savedPackages,
  save = savePackages,
  read = readCarMod,
} = {}) {
  let pending: Promise<void>;
  const store = createStore<ModsState>()((set, get) => ({
    selected: [],
    active: [],
    operation: "restoring",
    session: "idle",
    error: null,
    addFiles(files) {
      if (!files.length) return Promise.resolve();
      return update(async () => {
        const next = [...get().selected];
        for (const file of files) {
          if (!file.name.toLowerCase().endsWith(".tm4mod"))
            throw new Error(`${file.name}: choose a .tm4mod package`);
          if (file.size > maxModBytes) throw new Error(`${file.name}: exceeds 4 MiB`);
          const mod = await read(new Uint8Array(await file.arrayBuffer()));
          const index = next.findIndex((old) => old.manifest.id === mod.manifest.id);
          if (index >= 0) next[index] = mod;
          else next.push(mod);
        }
        return next;
      });
    },
    remove(id) {
      return update(() => get().selected.filter((mod) => mod.manifest.id !== id));
    },
    async beginSession() {
      if (get().session !== "idle") throw new Error("A mod session has already started");
      // Lock before waiting: an in-flight save belongs to this launch, later edits do not.
      set({ session: "starting" });
      await pending;
      const selected = [...get().selected];
      set({ active: selected });
      return [...selected];
    },
    finishStartup(started) {
      if (get().session !== "starting") return;
      set({ session: started ? "running" : "idle", ...(started ? {} : { active: [] }) });
    },
  }));

  function update(select: () => readonly CarMod[] | Promise<readonly CarMod[]>) {
    if (modsLocked(store.getState())) {
      store.setState({ error: "Please wait for the current operation, then add your mods again." });
      return Promise.resolve();
    }
    pending = pending
      .then(async () => {
        const selected = await select();
        validateSelection(selected);
        await save(selected);
        store.setState({ selected, error: null });
      })
      .catch((error: unknown) => {
        store.setState({ error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => store.setState({ operation: "idle" }));
    store.setState({ operation: "saving", error: null });
    return pending;
  }

  pending = (async () => {
    try {
      const stored = await load();
      if (stored.length > maxCarMods) throw new Error(`At most ${maxCarMods} mods per session`);
      const selected = await Promise.all(stored.map((bytes) => read(bytes)));
      validateSelection(selected);
      store.setState({ selected });
    } catch (error) {
      store.setState({
        error: `Could not restore saved mods: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      store.setState({ operation: "idle" });
    }
  })();
  return store;
}

export type ModsStore = ReturnType<typeof createModsStore>;
