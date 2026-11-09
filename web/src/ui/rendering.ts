import type { GameModule } from "../runtime/module.ts";
import { element } from "./dom.ts";

type Preset = "ultra" | "ps1";

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
    toggleSetting(
      "render-interpolation",
      module._WebSetRenderInterpolation,
      { ultra: true, ps1: false },
      changed,
    ),
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
