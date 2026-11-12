import type { GameModule } from "@tm4/game-runtime/runtime/module";

import { initializeInputSettings } from "./controls.ts";
import { element } from "./dom.ts";
import { initializePerformance } from "./performance.ts";
import { initializeRendering } from "./rendering.ts";

function initializeCheats(module: GameModule, panel: HTMLDetailsElement) {
  const toggles = [...panel.querySelectorAll<HTMLInputElement>("input[data-cheat]")];
  function refresh() {
    const flags = module._WebGetCheats();
    for (const toggle of toggles) toggle.checked = !!(flags & (1 << Number(toggle.dataset.cheat)));
  }
  for (const toggle of toggles) {
    toggle.addEventListener("change", () => {
      module._WebSetCheat(Number(toggle.dataset.cheat), Number(toggle.checked));
      refresh();
    });
  }
  element("cheat-reset", HTMLButtonElement).addEventListener("click", () => {
    for (const toggle of toggles) module._WebSetCheat(Number(toggle.dataset.cheat), 0);
    refresh();
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  panel.addEventListener("toggle", () => {
    clearInterval(timer);
    if (panel.open) {
      refresh();
      timer = setInterval(refresh, 500);
    }
  });
  panel.hidden = false;
  refresh();
}

export function initializeSettings(module: GameModule, canvas: HTMLCanvasElement) {
  const toolbar = element("video-controls", HTMLElement);
  const rendering = element("render-settings", HTMLDetailsElement);
  const cheats = element("cheat-settings", HTMLDetailsElement);
  const input = element("input-settings", HTMLDetailsElement);
  const resources = element("resources", HTMLDetailsElement);
  const panels = [rendering, cheats, input, resources, element("mods", HTMLDetailsElement)];
  const closePanels = () => {
    for (const panel of panels) panel.open = false;
  };
  for (const panel of panels) {
    const summary = panel.querySelector("summary");
    if (!summary) throw new Error("Settings panel has no summary");
    summary.addEventListener("click", () => {
      for (const other of panels) if (other !== panel) other.open = false;
    });
    panel.addEventListener("toggle", () => {
      if (panel.open) for (const other of panels) if (other !== panel) other.open = false;
    });
  }
  initializeInputSettings(module, toolbar, input, canvas);
  initializeCheats(module, cheats);
  input.hidden = false;
  rendering.hidden = false;
  toolbar.hidden = false;
  const settings = [initializeRendering(module), initializePerformance(module)];
  element("render-reset", HTMLButtonElement).addEventListener("click", () => {
    for (const setting of settings) setting.reset();
  });
  toolbar.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape" && !event.defaultPrevented) {
      closePanels();
      canvas.focus();
    }
  });
  toolbar.addEventListener("keyup", (event) => event.stopPropagation());
  canvas.addEventListener("pointerdown", closePanels);
}
