import { createStore } from "zustand/vanilla";

export const simulationStepMs = 1000 / 30;
export const smoothingDelays = [0, 5, 10, 15, 20, 25, 30, simulationStepMs];
export type RenderingPreset = "ultra" | "ps1" | "custom";
export interface RenderingSettings {
  scale: number;
  carLodDistance: number;
  drawDistance: number;
  dithering: number;
  renderLimit: number;
  subpixelVertices: boolean;
  perspectiveTextures: boolean;
  smoothing: boolean;
  smoothingDelay: number;
}
const presets: Record<Exclude<RenderingPreset, "custom">, RenderingSettings> = {
  ultra: {
    scale: 8,
    carLodDistance: 8,
    drawDistance: 8,
    dithering: 0,
    renderLimit: 120,
    subpixelVertices: true,
    perspectiveTextures: true,
    smoothing: true,
    smoothingDelay: simulationStepMs,
  },
  ps1: {
    scale: 1,
    carLodDistance: 1,
    drawDistance: 1,
    dithering: 0,
    renderLimit: 30,
    subpixelVertices: false,
    perspectiveTextures: false,
    smoothing: false,
    smoothingDelay: simulationStepMs,
  },
};
interface RenderingState {
  settings: RenderingSettings;
  preset: RenderingPreset;
  network: boolean;
  showPerformance: boolean;
  change: (settings: Partial<RenderingSettings>) => void;
  selectPreset: (preset: RenderingPreset) => void;
  setNetwork: (active: boolean) => void;
  setShowPerformance: (enabled: boolean) => void;
  reset: () => void;
}

export function effectiveRenderingSettings(
  state: Pick<RenderingState, "settings" | "network">,
): RenderingSettings {
  return state.network ? { ...state.settings, renderLimit: 30, smoothing: false } : state.settings;
}

export function createRenderingStore(showPerformance = false) {
  return createStore<RenderingState>()((set, get) => ({
    settings: { ...presets.ultra },
    preset: "ultra",
    network: false,
    showPerformance,
    change(patch) {
      const state = get();
      const settings = { ...state.settings, ...patch };
      if (state.network) {
        settings.renderLimit = state.settings.renderLimit;
        settings.smoothing = state.settings.smoothing;
        settings.smoothingDelay = state.settings.smoothingDelay;
      }
      if (
        Object.keys(settings).every(
          (key) =>
            settings[key as keyof RenderingSettings] ===
            state.settings[key as keyof RenderingSettings],
        )
      )
        return;
      set({ settings, preset: "custom" });
    },
    selectPreset(preset) {
      if (preset === "custom") {
        set({ preset });
        return;
      }
      const state = get();
      const settings = { ...presets[preset] };
      // Network overrides do not replace the user's single-player timing choices.
      if (state.network) {
        settings.renderLimit = state.settings.renderLimit;
        settings.smoothing = state.settings.smoothing;
        settings.smoothingDelay = state.settings.smoothingDelay;
      }
      set({ settings, preset });
    },
    setNetwork(active) {
      const state = get();
      if (state.network === active) return;
      let preset = state.preset;
      if (!active && preset !== "custom") {
        const expected = presets[preset];
        if (
          state.settings.renderLimit !== expected.renderLimit ||
          state.settings.smoothing !== expected.smoothing ||
          state.settings.smoothingDelay !== expected.smoothingDelay
        )
          preset = "custom";
      }
      set({ network: active, preset });
    },
    setShowPerformance: (enabled) => set({ showPerformance: enabled }),
    reset() {
      get().selectPreset("ultra");
      set({ showPerformance: false });
    },
  }));
}
export type RenderingStore = ReturnType<typeof createRenderingStore>;
