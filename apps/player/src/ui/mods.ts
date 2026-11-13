import { modsLocked, modsMessage, modsNeedRestart, type ModsStore } from "../state/mods.ts";
import { element } from "./dom.ts";

export function initializeMods(store: ModsStore) {
  const pickers = [
    element("startup-mod-files", HTMLInputElement),
    element("mod-files", HTMLInputElement),
  ];
  const lists = [element("startup-mod-list", HTMLElement), element("mod-list", HTMLElement)];
  const status = element("mod-status", HTMLElement);
  const startupStatus = element("startup-mod-status", HTMLElement);
  const restart = element("mod-restart", HTMLButtonElement);
  function render() {
    const state = store.getState();
    const locked = modsLocked(state);
    status.textContent = startupStatus.textContent = modsMessage(state);
    restart.hidden = !modsNeedRestart(state);
    restart.disabled = locked;
    for (const list of lists) {
      list.replaceChildren();
      for (const mod of state.selected) {
        const item = document.createElement("li");
        const caption = document.createElement("span");
        caption.textContent =
          mod.manifest.version === 1
            ? `${mod.manifest.name} · base: ${mod.manifest.base}`
            : mod.manifest.name;
        item.append(caption);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.disabled = locked;
        remove.addEventListener("click", () => void store.getState().remove(mod.manifest.id));
        item.append(remove);
        for (const warning of mod.warnings) {
          const note = document.createElement("small");
          note.textContent = warning;
          item.append(note);
        }
        list.append(item);
      }
    }
    for (const input of pickers) input.disabled = locked;
  }
  store.subscribe(render);
  render();
  for (const input of pickers)
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.value = "";
      void store.getState().addFiles(files);
    });

  const dropHint = element("mod-drop-hint", HTMLElement);
  let dragDepth = 0;
  function resetDrag() {
    dragDepth = 0;
    dropHint.hidden = true;
  }
  function hasFiles(event: DragEvent) {
    return event.dataTransfer?.types.includes("Files") ?? false;
  }
  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    ++dragDepth;
    dropHint.textContent = modsLocked(store.getState())
      ? "Please wait before adding mods"
      : "Drop .tm4mod packages to add mods";
    dropHint.hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = modsLocked(store.getState()) ? "none" : "copy";
  });
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) resetDrag();
  });
  window.addEventListener("drop", (event) => {
    resetDrag();
    if (!hasFiles(event)) return;
    event.preventDefault();
    const panel = element(
      store.getState().session === "running" ? "mods" : "startup-mods",
      HTMLDetailsElement,
    );
    panel.open = true;
    void store.getState().addFiles([...(event.dataTransfer?.files ?? [])]);
  });
  window.addEventListener("dragend", resetDrag);
  window.addEventListener("blur", resetDrag);
  restart.addEventListener("click", () => location.reload());
}
