import { type CarMod, maxCarMods, maxModBytes, readCarMod } from "@tm4/resources/mods/package";

import { savedPackages, savePackages } from "../mods/storage.ts";
import { element } from "./dom.ts";

export function initializeMods() {
  const pickers = [
    element("startup-mod-files", HTMLInputElement),
    element("mod-files", HTMLInputElement),
  ];
  const lists = [element("startup-mod-list", HTMLElement), element("mod-list", HTMLElement)];
  const status = element("mod-status", HTMLElement);
  const startupStatus = element("startup-mod-status", HTMLElement);
  const restart = element("mod-restart", HTMLButtonElement);
  let packages: CarMod[] = [];
  let running = false;
  let locked = false;
  let pending: Promise<void> = Promise.resolve();
  function message(text: string) {
    status.textContent = text;
    startupStatus.textContent = text;
  }
  function render() {
    for (const list of lists) {
      list.replaceChildren();
      for (const mod of packages) {
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
        remove.addEventListener("click", () =>
          enqueue(async () => {
            await update(packages.filter((p) => p !== mod));
          }),
        );
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
  async function update(next: CarMod[]) {
    await savePackages(next);
    packages = next;
    render();
    restart.hidden = !running;
    message(
      running
        ? "Saved for the next session. Restart to apply; select your disc folder again if asked."
        : "Mods ready. Select your disc folder to start.",
    );
  }
  function enqueue(action: () => Promise<void>) {
    if (locked) return;
    locked = true;
    render();
    pending = pending
      .then(action)
      .catch((error: unknown) => {
        message(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        locked = false;
        render();
      });
  }
  function addFiles(files: File[]) {
    if (!files.length) return;
    if (locked) {
      message("Please wait for the current operation, then add your mods again.");
      return;
    }
    enqueue(async () => {
      const next = [...packages];
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith(".tm4mod"))
          throw new Error(`${file.name}: choose a .tm4mod package`);
        if (file.size > maxModBytes) throw new Error(`${file.name}: exceeds 4 MiB`);
        const mod = await readCarMod(new Uint8Array(await file.arrayBuffer()));
        const index = next.findIndex((p) => p.manifest.id === mod.manifest.id);
        if (index >= 0) next[index] = mod;
        else next.push(mod);
      }
      if (next.length > maxCarMods) throw new Error(`At most ${maxCarMods} mods per session`);
      const names = next.map((m) => m.manifest.name.toLowerCase());
      if (new Set(names).size !== names.length) throw new Error("Two mods use the same car name");
      await update(next);
    });
  }
  for (const input of pickers)
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.value = "";
      addFiles(files);
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
    dropHint.textContent = locked
      ? "Please wait before adding mods"
      : "Drop .tm4mod packages to add mods";
    dropHint.hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = locked ? "none" : "copy";
  });
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) resetDrag();
  });
  window.addEventListener("drop", (event) => {
    resetDrag();
    if (!hasFiles(event)) return;
    event.preventDefault();
    const panel = element(running ? "mods" : "startup-mods", HTMLDetailsElement);
    panel.open = true;
    addFiles([...(event.dataTransfer?.files ?? [])]);
  });
  window.addEventListener("dragend", resetDrag);
  window.addEventListener("blur", resetDrag);
  restart.addEventListener("click", () => location.reload());
  pending = (async () => {
    try {
      const stored = await savedPackages();
      if (stored.length > maxCarMods) throw new Error("Too many saved mods");
      packages = await Promise.all(stored.map(readCarMod));
      render();
    } catch (error) {
      message(
        `Could not restore saved mods: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  return {
    async beginSession() {
      await pending;
      locked = true;
      render();
      return [...packages];
    },
    finishStartup(started: boolean) {
      running = started;
      locked = false;
      render();
      message(
        started && packages.length
          ? `${packages.length} mod(s) active. Changes apply after restarting.`
          : "",
      );
    },
  };
}
