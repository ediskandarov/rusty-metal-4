import { element } from "./dom.ts";

export function initializePopups() {
  const toolbar = element("video-controls", HTMLElement);
  const button = element("settings-toggle", HTMLButtonElement);
  const contents = element("settings-menu", HTMLElement);
  const menus = [...contents.querySelectorAll<HTMLDetailsElement>(":scope > details")];
  function showSettings(open: boolean) {
    contents.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (!open) for (const menu of menus) menu.open = false;
    fitPopups();
  }
  button.addEventListener("click", () => showSettings(!!contents.hidden));
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !toolbar.contains(event.target)) showSettings(false);
  });
  toolbar.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      showSettings(false);
      event.stopPropagation();
      element("canvas", HTMLCanvasElement).focus();
    }
  });
  function fitPopups() {
    const viewport = window.visualViewport;
    const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    for (const menu of menus) {
      if (!menu.open || menu.hidden || toolbar.hidden) continue;
      const popup = menu.querySelector<HTMLElement>(":scope > .settings-panel");
      if (!popup) continue;
      const height = Math.max(0, bottom - popup.getBoundingClientRect().top - 12);
      popup.style.setProperty("--popup-height", `${height}px`);
    }
  }
  new ResizeObserver(fitPopups).observe(toolbar);
  for (const menu of menus) {
    menu.addEventListener("toggle", () => {
      if (menu.open) showSettings(true);
      fitPopups();
    });
  }
  window.addEventListener("resize", fitPopups);
  window.visualViewport?.addEventListener("resize", fitPopups);
  window.visualViewport?.addEventListener("scroll", fitPopups);
}
