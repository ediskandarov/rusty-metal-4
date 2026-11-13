import { element } from "./dom.ts";

export function initializeFullscreen(canvas: HTMLCanvasElement) {
  const button = element("fullscreen-toggle", HTMLButtonElement);
  const label = element("fullscreen-label", HTMLElement);
  const error = element("fullscreen-error", HTMLElement);
  if (!document.fullscreenEnabled) return;

  button.hidden = false;
  let changing = false;
  let suppressEscape = false;
  let wasFullscreen = !!document.fullscreenElement;

  function refresh() {
    const active = !!document.fullscreenElement;
    label.textContent = active ? "Exit fullscreen" : "Fullscreen";
    button.setAttribute("aria-pressed", String(active));
    button.title = active
      ? "Exit fullscreen (Esc or double-click the game)"
      : "Fullscreen (or double-click the game)";
    if (wasFullscreen && !active) suppressEscape = true;
    wasFullscreen = active;
  }

  async function toggle() {
    if (changing) return;
    changing = true;
    error.hidden = true;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      canvas.focus({ preventScroll: true });
    } catch (reason) {
      error.textContent = "Could not switch fullscreen. Try again or check browser permissions.";
      error.hidden = false;
      console.warn("Fullscreen request failed", reason);
    } finally {
      changing = false;
      refresh();
    }
  }

  button.addEventListener("click", () => void toggle());
  canvas.addEventListener("dblclick", (event) => {
    event.preventDefault();
    void toggle();
  });
  document.addEventListener("fullscreenchange", refresh);

  // Install before game input: the Escape used to exit must not also pause the game.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      if (document.fullscreenElement || (suppressEscape && event.repeat)) {
        suppressEscape = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (document.fullscreenElement) void toggle();
      } else suppressEscape = false;
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (event) => {
      if (event.key !== "Escape" || !suppressEscape) return;
      suppressEscape = false;
      event.stopImmediatePropagation();
    },
    true,
  );
  refresh();
}
