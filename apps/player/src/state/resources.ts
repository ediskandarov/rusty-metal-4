import {
  checkResources,
  type ResourceCandidate,
  resourceReference,
  type ResourceRow,
  resourceRows,
} from "@tm4/resources/compatibility";
import { discoverResources } from "@tm4/resources/loader/resources";
import type { DiscSources } from "@tm4/resources/loader/types";
import { createStore } from "zustand/vanilla";

type ResourcesPhase = "idle" | "reading" | "checking" | "paused" | "complete" | "failed";

interface ResourcesState {
  phase: ResourcesPhase;
  rows: ResourceRow[];
  notices: string[];
  error: string | null;
  query: string;
  issuesOnly: boolean;
  inspect: (sources: DiscSources) => Promise<void>;
  pause: () => void;
  resume: () => void;
  setQuery: (query: string) => void;
  setIssuesOnly: (issuesOnly: boolean) => void;
}

export function createResourcesStore(discover: typeof discoverResources = discoverResources) {
  let controller: AbortController | null = null;
  let candidates: ResourceCandidate[] = [];
  const store = createStore<ResourcesState>()((set, get) => ({
    phase: "idle",
    rows: [],
    notices: [],
    error: null,
    query: "",
    issuesOnly: false,
    async inspect(sources) {
      controller?.abort();
      const current = (controller = new AbortController());
      candidates = [];
      set({ phase: "reading", rows: [], notices: [], error: null, query: "", issuesOnly: false });
      try {
        const found = await discover(sources, current.signal);
        if (controller !== current) return;
        const rows = resourceRows(found.resources, resourceReference);
        candidates = found.resources;
        set({ rows, notices: found.notices, phase: "paused" });
        get().resume();
      } catch (error) {
        if (controller !== current) return;
        controller = null;
        set({ phase: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    },
    pause() {
      if (get().phase !== "checking") return;
      controller?.abort();
      controller = null;
      set({
        phase: "paused",
        rows: get().rows.map((row) =>
          row.status === "checking" ? { ...row, status: "pending", message: "" } : row,
        ),
      });
    },
    resume() {
      if (get().phase !== "paused") return;
      controller?.abort();
      const current = (controller = new AbortController());
      // The checker mutates its working rows; published store snapshots must remain immutable.
      const rows = get().rows.map((row) => ({ ...row }));
      set({ phase: "checking", error: null });
      void runChecks(current, rows);
    },
    setQuery: (query) => set({ query }),
    setIssuesOnly: (issuesOnly) => set({ issuesOnly }),
  }));

  async function runChecks(current: AbortController, rows: ResourceRow[]) {
    try {
      await checkResources(candidates, rows, current.signal, (changed) => {
        if (controller !== current) return;
        store.setState((state) => ({
          rows: state.rows.map((row) => (row.id === changed.id ? { ...changed } : row)),
        }));
      });
    } catch (error) {
      if (controller === current)
        store.setState({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (controller === current) {
        controller = null;
        store.setState({
          phase: rows.some((row) => row.status === "pending") ? "paused" : "complete",
        });
      }
    }
  }
  return store;
}

export type ResourcesStore = ReturnType<typeof createResourcesStore>;
