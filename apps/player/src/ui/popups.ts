import { element } from "./dom.ts";

export function initializePopups() {
  const toolbar = element("video-controls", HTMLElement);
  const menus = [...toolbar.querySelectorAll<HTMLDetailsElement>(":scope > details")];
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
  for (const menu of menus) menu.addEventListener("toggle", fitPopups);
  window.addEventListener("resize", fitPopups);
  window.visualViewport?.addEventListener("resize", fitPopups);
  window.visualViewport?.addEventListener("scroll", fitPopups);
}
