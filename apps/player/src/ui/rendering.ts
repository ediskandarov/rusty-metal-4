import type { GameModule } from "@tm4/game-client/runtime/module";

import { element } from "./dom.ts";

type Preset = "ultra" | "ps1";

const simulationStepMs = 1000 / 30;
const smoothingDelays = [0, 5, 10, 15, 20, 25, 30, simulationStepMs];

function selectSetting(
  id: string,
  set: (value: number) => void,
  values: Record<Preset, number>,
  changed: () => void,
) {
  const select = element(id, HTMLSelectElement);
  select.addEventListener("change", () => {
    set(Number(select.value));
    changed();
  });
  return (preset: Preset) => {
    select.value = String(values[preset]);
    set(values[preset]);
  };
}

function toggleSetting(
  id: string,
  set: (value: number) => void,
  values: Record<Preset, boolean>,
  changed: () => void,
) {
  const checkbox = element(id, HTMLInputElement);
  checkbox.addEventListener("change", () => {
    set(Number(checkbox.checked));
    changed();
  });
  return (preset: Preset) => {
    checkbox.checked = values[preset];
    set(Number(values[preset]));
  };
}

function smoothingSettings(module: GameModule, changed: () => void) {
  const enabled = element("render-smoothing", HTMLInputElement);
  const slider = element("render-smoothing-delay", HTMLInputElement);
  const readout = element("render-smoothing-readout", HTMLOutputElement);
  let networkMode = false;
  let offlineEnabled = enabled.checked;
  const milliseconds = (value: number) => `${Number(value.toFixed(1))} ms`;

  function applyDelay() {
    const delay = smoothingDelays[Number(slider.value)] ?? simulationStepMs;
    const label =
      delay === simulationStepMs
        ? "33.3 ms · Full interpolation · No prediction"
        : `${milliseconds(delay)} · Up to ${milliseconds(simulationStepMs - delay)} prediction`;
    module._WebSetRenderSmoothingDelay(delay);
    readout.value = label;
    slider.setAttribute("aria-valuetext", label);
  }

  function applyEnabled() {
    slider.disabled = networkMode || !enabled.checked;
    module._WebSetRenderSmoothing(Number(enabled.checked));
  }

  slider.addEventListener("input", () => {
    applyDelay();
    changed();
  });
  enabled.addEventListener("change", () => {
    applyEnabled();
    changed();
  });

  return {
    matches(preset: Preset) {
      return (
        enabled.checked === (preset === "ultra") &&
        slider.value === String(smoothingDelays.length - 1)
      );
    },
    preset(preset: Preset) {
      enabled.checked = preset === "ultra";
      slider.value = String(smoothingDelays.length - 1);
      applyDelay();
      applyEnabled();
    },
    network(active: boolean) {
      if (active === networkMode) return;
      if (active) offlineEnabled = enabled.checked;
      networkMode = active;
      enabled.disabled = active;
      enabled.checked = active ? false : offlineEnabled;
      applyEnabled();
      if (active) readout.value = "Disabled in network matches";
      else applyDelay();
    },
  };
}

export function initializeRendering(module: GameModule) {
  const selector = element("render-preset", HTMLSelectElement);
  const changed = () => {
    selector.value = "custom";
  };
  let networkMode = false;
  const limit = element("render-limit", HTMLSelectElement);
  let offlineLimit = limit.value;
  const networkNote = element("network-render-note", HTMLParagraphElement);
  const limitSetting = selectSetting(
    "render-limit",
    module._WebSetRenderLimit,
    { ultra: 120, ps1: 30 },
    changed,
  );
  const smoothing = smoothingSettings(module, changed);
  const settings = [
    selectSetting(
      "texture-filtering",
      module._WebSetTextureFiltering,
      { ultra: 1, ps1: 0 },
      changed,
    ),
    selectSetting("render-antialiasing", module._WebSetAntialiasing, { ultra: 2, ps1: 0 }, changed),
    selectSetting("render-scale", module._WebSetRenderScale, { ultra: 8, ps1: 1 }, changed),
    selectSetting("car-lod-distance", module._WebSetCarLodDistance, { ultra: 8, ps1: 1 }, changed),
    selectSetting("draw-distance", module._WebSetDrawDistance, { ultra: 8, ps1: 1 }, changed),
    selectSetting("render-dithering", module._WebSetRenderDithering, { ultra: 0, ps1: 0 }, changed),
    toggleSetting(
      "subpixel-vertices",
      module._WebSetSubpixelVertices,
      { ultra: true, ps1: false },
      changed,
    ),
    toggleSetting(
      "perspective-textures",
      module._WebSetPerspectiveTextures,
      { ultra: true, ps1: false },
      changed,
    ),
  ];
  function apply(preset: Preset) {
    for (const setting of settings) setting(preset);
    if (!networkMode) {
      limitSetting(preset);
      smoothing.preset(preset);
    }
    selector.value = preset;
  }
  selector.addEventListener("change", () => {
    if (selector.value === "ultra" || selector.value === "ps1") apply(selector.value);
  });
  window.addEventListener("tm4-network-mode", (event) => {
    const active = (event as CustomEvent<boolean>).detail;
    if (active === networkMode) return;
    if (active) offlineLimit = limit.value;
    networkMode = active;
    networkNote.hidden = !active;
    limit.disabled = active;
    limit.value = active ? "30" : offlineLimit;
    module._WebSetRenderLimit(Number(limit.value));
    smoothing.network(active);
    const preset = selector.value;
    if (
      !active &&
      (preset === "ultra" || preset === "ps1") &&
      (limit.value !== (preset === "ultra" ? "120" : "30") || !smoothing.matches(preset))
    )
      changed();
  });
  apply("ultra");
  return { reset: () => apply("ultra") };
}
