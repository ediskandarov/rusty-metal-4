import {
  createModLibraryStore,
  installMod,
  removeMod,
  sessionReleases,
  setModEnabled,
} from "@tm4/mods/library";

const store = createModLibraryStore();
const list = document.querySelector<HTMLElement>("#mod-library")!;
const picker = document.querySelector<HTMLInputElement>("#mod-import")!;
const status = document.querySelector<HTMLElement>("#mod-library-status")!;
const error = document.querySelector<HTMLElement>("#mod-library-error")!;

function button(label: string, busy: boolean, action: () => Promise<void>) {
  const control = document.createElement("button");
  control.textContent = label;
  control.type = "button";
  control.className = "button-secondary";
  control.disabled = busy;
  control.onclick = () => void store.run(action);
  return control;
}

function render(state: ReturnType<typeof store.getState>) {
  const { library, busy } = state;
  picker.disabled = busy;
  status.textContent = state.status || (busy ? "Updating library…" : "");
  error.textContent = state.error;
  error.hidden = !state.error;
  list.replaceChildren();
  if (!library.releases.length) {
    const item = document.createElement("p");
    item.textContent = "No mods installed.";
    list.append(item);
    return;
  }
  const active = new Set(sessionReleases(library).map(({ digest }) => digest));
  for (const release of library.releases) {
    const { manifest, digest, size } = release;
    const enabled = library.enabled.includes(digest);
    const required = !enabled && active.has(digest);
    const selection = enabled ? "Enabled" : required ? "Required by an enabled mod" : "Disabled";
    const row = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = `${manifest.name} ${manifest.version}`;
    const summary = document.createElement("p");
    summary.textContent = `${(size / 1024 / 1024).toFixed(1)} MiB · ${selection}`;
    const actions = document.createElement("div");
    actions.className = "intro-actions";
    if (!required) {
      actions.append(
        button(enabled ? "Disable" : "Enable", busy, () => setModEnabled(digest, !enabled)),
      );
    }
    actions.append(button("Remove", busy || required, () => removeMod(digest)));
    row.append(title, summary, actions);
    list.append(row);
  }
}

picker.onchange = () => {
  const file = picker.files?.[0];
  if (!file) return;
  picker.value = "";
  void store.run(async () => {
    if (!file.name.toLowerCase().endsWith(".tm4mod")) throw Error("Choose a .tm4mod package");
    await installMod(file);
    void navigator.storage?.persist().catch(() => undefined);
  });
};
store.subscribe(render);
render(store.getState());
