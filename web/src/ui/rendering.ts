import type { GameModule } from "../runtime/module.ts";
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
    slider.disabled = !enabled.checked;
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

  return (preset: Preset) => {
    enabled.checked = preset === "ultra";
    slider.value = String(smoothingDelays.length - 1);
    applyDelay();
    applyEnabled();
  };
}

export function initializeRendering(module: GameModule) {
  const selector = element("render-preset", HTMLSelectElement);
  const changed = () => {
    selector.value = "custom";
  };
  const settings = [
    selectSetting("render-scale", module._WebSetRenderScale, { ultra: 8, ps1: 1 }, changed),
    selectSetting("car-lod-distance", module._WebSetCarLodDistance, { ultra: 8, ps1: 1 }, changed),
    selectSetting("draw-distance", module._WebSetDrawDistance, { ultra: 8, ps1: 1 }, changed),
    selectSetting("render-dithering", module._WebSetRenderDithering, { ultra: 0, ps1: 0 }, changed),
    selectSetting("render-limit", module._WebSetRenderLimit, { ultra: 120, ps1: 30 }, changed),
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
    smoothingSettings(module, changed),
  ];
  function apply(preset: Preset) {
    for (const setting of settings) setting(preset);
    selector.value = preset;
  }
  selector.addEventListener("change", () => {
    if (selector.value === "ultra" || selector.value === "ps1") apply(selector.value);
  });
  apply("ultra");
  return { reset: () => apply("ultra") };
}
