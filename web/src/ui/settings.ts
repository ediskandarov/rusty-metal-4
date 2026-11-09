import type { GameModule } from "../runtime/module.ts";
import { initializeInputSettings } from "./controls.ts";
import { element } from "./dom.ts";
import { initializeRendering } from "./rendering.ts";

type Setting = { reset(): void };

function initializeFPS(module: GameModule): Setting {
  const checkbox = element("render-fps", HTMLInputElement);
  const counter = element("fps-counter", HTMLElement);
  let timer: ReturnType<typeof setInterval> | undefined;
  let time = 0;
  let frames = 0;
  function sample() {
    time = performance.now();
    frames = module._WebGetPresentedFrames() >>> 0;
    counter.textContent = "FPS —";
  }
  function update() {
    clearInterval(timer);
    counter.hidden = !checkbox.checked;
    if (!checkbox.checked) return;
    sample();
    timer = setInterval(() => {
      if (document.hidden) return;
      const now = performance.now();
      const current = module._WebGetPresentedFrames() >>> 0;
      const fps = (((current - frames) >>> 0) * 1000) / (now - time);
      counter.textContent = `FPS ${fps.toFixed(1)}`;
      frames = current;
      time = now;
    }, 500);
  }
  checkbox.checked = new URLSearchParams(location.search).get("fps") === "1";
  checkbox.addEventListener("change", update);
  document.addEventListener("visibilitychange", () => {
    if (checkbox.checked) sample();
  });
  update();
  return {
    reset() {
      checkbox.checked = false;
      update();
    },
  };
}

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
  const panels = [rendering, cheats, input, resources];
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
  const settings = [initializeRendering(module), initializeFPS(module)];
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
