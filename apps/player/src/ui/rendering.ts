import type { GameModule } from "@tm4/game-runtime/runtime/module";

import {
  effectiveRenderingSettings,
  type RenderingSettings,
  type RenderingStore,
  simulationStepMs,
  smoothingDelays,
} from "../state/rendering.ts";
import { element } from "./dom.ts";

export function applyRenderingSettings(
  module: GameModule,
  settings: RenderingSettings,
  previous?: RenderingSettings,
) {
  if (settings.scale !== previous?.scale) module._WebSetRenderScale(settings.scale);
  if (settings.carLodDistance !== previous?.carLodDistance)
    module._WebSetCarLodDistance(settings.carLodDistance);
  if (settings.drawDistance !== previous?.drawDistance)
    module._WebSetDrawDistance(settings.drawDistance);
  if (settings.dithering !== previous?.dithering) module._WebSetRenderDithering(settings.dithering);
  if (settings.subpixelVertices !== previous?.subpixelVertices)
    module._WebSetSubpixelVertices(Number(settings.subpixelVertices));
  if (settings.perspectiveTextures !== previous?.perspectiveTextures)
    module._WebSetPerspectiveTextures(Number(settings.perspectiveTextures));
  if (settings.renderLimit !== previous?.renderLimit)
    module._WebSetRenderLimit(settings.renderLimit);
  if (settings.smoothingDelay !== previous?.smoothingDelay)
    module._WebSetRenderSmoothingDelay(settings.smoothingDelay);
  if (settings.smoothing !== previous?.smoothing)
    module._WebSetRenderSmoothing(Number(settings.smoothing));
}

export function initializeRendering(module: GameModule, store: RenderingStore) {
  const selector = element("render-preset", HTMLSelectElement);
  const limit = element("render-limit", HTMLSelectElement);
  const enabled = element("render-smoothing", HTMLInputElement);
  const slider = element("render-smoothing-delay", HTMLInputElement);
  const readout = element("render-smoothing-readout", HTMLOutputElement);
  const networkNote = element("network-render-note", HTMLParagraphElement);
  const selects = {
    scale: element("render-scale", HTMLSelectElement),
    carLodDistance: element("car-lod-distance", HTMLSelectElement),
    drawDistance: element("draw-distance", HTMLSelectElement),
    dithering: element("render-dithering", HTMLSelectElement),
    renderLimit: limit,
  };
  const toggles = {
    subpixelVertices: element("subpixel-vertices", HTMLInputElement),
    perspectiveTextures: element("perspective-textures", HTMLInputElement),
    smoothing: enabled,
  };
  for (const [key, input] of Object.entries(selects))
    input.addEventListener("change", () => store.getState().change({ [key]: Number(input.value) }));
  for (const [key, input] of Object.entries(toggles))
    input.addEventListener("change", () => store.getState().change({ [key]: input.checked }));
  slider.addEventListener("input", () =>
    store
      .getState()
      .change({ smoothingDelay: smoothingDelays[Number(slider.value)] ?? simulationStepMs }),
  );
  selector.addEventListener("change", () => {
    const value = selector.value;
    if (value === "ultra" || value === "ps1" || value === "custom")
      store.getState().selectPreset(value);
  });
  window.addEventListener("tm4-network-mode", (event) => {
    store.getState().setNetwork((event as CustomEvent<boolean>).detail);
  });

  function render(state: ReturnType<RenderingStore["getState"]>, previous?: typeof state) {
    const settings = effectiveRenderingSettings(state);
    applyRenderingSettings(module, settings, previous && effectiveRenderingSettings(previous));
    selector.value = state.preset;
    for (const key of Object.keys(selects) as (keyof typeof selects)[])
      selects[key].value = String(settings[key]);
    for (const key of Object.keys(toggles) as (keyof typeof toggles)[])
      toggles[key].checked = settings[key];
    limit.disabled = state.network;
    enabled.disabled = state.network;
    slider.disabled = state.network || !settings.smoothing;
    slider.value = String(smoothingDelays.indexOf(settings.smoothingDelay));
    networkNote.hidden = !state.network;
    const milliseconds = (value: number) => `${Number(value.toFixed(1))} ms`;
    const delay = settings.smoothingDelay;
    const label = state.network
      ? "Disabled in network matches"
      : delay === simulationStepMs
        ? "33.3 ms · Full interpolation · No prediction"
        : `${milliseconds(delay)} · Up to ${milliseconds(simulationStepMs - delay)} prediction`;
    readout.value = label;
    slider.setAttribute("aria-valuetext", label);
  }
  render(store.getState());
  return store.subscribe(render);
}
