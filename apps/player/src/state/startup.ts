import { createStore } from "zustand/vanilla";

export type StartupPhase =
  | { kind: "preparing-browser" }
  | { kind: "ready" }
  | { kind: "connecting-disc" }
  | { kind: "loading-disc"; message: string }
  | { kind: "installing-mods" }
  | { kind: "starting-runtime" }
  | { kind: "running" }
  | { kind: "failed"; source: "browser" | "disc" | "runtime"; message: string };

export function canSelectDisc(phase: StartupPhase) {
  return phase.kind === "ready" || (phase.kind === "failed" && phase.source === "disc");
}

export function runtimeWasStarted(phase: StartupPhase) {
  return (
    phase.kind === "starting-runtime" ||
    phase.kind === "running" ||
    (phase.kind === "failed" && phase.source === "runtime")
  );
}

export type DiscSource = "folder" | "dev-server";

interface StartupState {
  phase: StartupPhase;
  warnings: readonly string[];
  browserReady: () => void;
  begin: (source: DiscSource) => boolean;
  loadDisc: (warnings?: readonly string[]) => void;
  reportProgress: (message: string) => void;
  warn: (message: string) => void;
  prepareMods: () => void;
  startRuntime: () => void;
  complete: () => void;
  fail: (error: unknown) => void;
}

export function createStartupStore() {
  return createStore<StartupState>()((set, get) => ({
    phase: { kind: "preparing-browser" },
    warnings: [],
    browserReady() {
      if (get().phase.kind === "preparing-browser") set({ phase: { kind: "ready" } });
    },
    begin(source) {
      if (!canSelectDisc(get().phase)) return false;
      set({
        phase:
          source === "dev-server"
            ? { kind: "connecting-disc" }
            : { kind: "loading-disc", message: "Reading disc directory…" },
        warnings: [],
      });
      return true;
    },
    loadDisc(warnings = []) {
      const state = get();
      if (state.phase.kind !== "connecting-disc" && state.phase.kind !== "loading-disc") return;
      set({
        phase: { kind: "loading-disc", message: "Reading disc directory…" },
        warnings: [...state.warnings, ...warnings],
      });
    },
    reportProgress(message) {
      if (get().phase.kind === "loading-disc") set({ phase: { kind: "loading-disc", message } });
    },
    warn(message) {
      const state = get();
      if (state.phase.kind === "loading-disc") set({ warnings: [...state.warnings, message] });
    },
    prepareMods() {
      if (get().phase.kind === "loading-disc") set({ phase: { kind: "installing-mods" } });
    },
    startRuntime() {
      if (get().phase.kind === "installing-mods") set({ phase: { kind: "starting-runtime" } });
    },
    complete() {
      if (get().phase.kind === "starting-runtime") set({ phase: { kind: "running" } });
    },
    fail(error) {
      const { phase } = get();
      if (phase.kind === "failed" || phase.kind === "running") return;
      set({
        phase: {
          kind: "failed",
          source:
            phase.kind === "preparing-browser"
              ? "browser"
              : phase.kind === "starting-runtime"
                ? "runtime"
                : "disc",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    },
  }));
}

export type StartupStore = ReturnType<typeof createStartupStore>;
