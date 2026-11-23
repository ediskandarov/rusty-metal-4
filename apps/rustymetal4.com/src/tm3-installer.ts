import { createModLibraryStore, installMod, sessionReleases } from "@tm4/mods/library";
import { type ConverterReply, type ConverterRequest, loadTm3Converter } from "@tm4/mods/recipe";

const form = document.querySelector<HTMLFormElement>("#tm3-build")!;
const modDisc = document.querySelector<HTMLInputElement>("#tm3-disc")!;
const baseDisc = document.querySelector<HTMLInputElement>("#tm4-disc")!;
const build = document.querySelector<HTMLButtonElement>("#build-mod")!;
const cancel = document.querySelector<HTMLButtonElement>("#cancel-build")!;
const status = document.querySelector<HTMLElement>("#mod-build-status")!;
const error = document.querySelector<HTMLElement>("#mod-build-error")!;
const play = document.querySelector<HTMLAnchorElement>("#mod-play")!;

const challenge = document.querySelector<HTMLAnchorElement>("#tm3-challenge")!;
const installed = document.querySelector<HTMLElement>("#tm3-installed-status")!;
const libraryStore = createModLibraryStore();

function showInstallation({ library, error }: ReturnType<typeof libraryStore.getState>) {
  const enabled = sessionReleases(library).find(({ manifest }) => manifest.id === "tm3");
  const release = enabled ?? library.releases.find(({ manifest }) => manifest.id === "tm3");
  installed.textContent =
    error ||
    (release
      ? `TM3 ${release.manifest.version} is installed and ${enabled ? "enabled" : "disabled"}.`
      : "");
  installed.hidden = !installed.textContent;
  play.hidden = challenge.hidden = !enabled;
}
libraryStore.subscribe(showInstallation);
showInstallation(libraryStore.getState());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void libraryStore.refresh();
});

let available: Pick<ConverterRequest, "converter" | "runtime" | "version"> | undefined;
let active: Worker | undefined;

function finish(message = "", failure = "") {
  active?.terminate();
  active = undefined;
  modDisc.disabled = baseDisc.disabled = false;
  build.disabled = !available;
  cancel.hidden = true;
  status.textContent = message;
  error.textContent = failure;
  error.hidden = !failure;
}

cancel.onclick = () => finish("Build cancelled.");
form.onsubmit = (event) => {
  event.preventDefault();
  if (!available || build.disabled || !modDisc.files?.length || !baseDisc.files?.length) return;
  const request = { ...available, modDisc: [...modDisc.files], baseDisc: [...baseDisc.files] };
  const worker = new Worker(new URL("./mod-converter.worker.ts", import.meta.url), {
    type: "module",
  });
  active = worker;
  modDisc.disabled = baseDisc.disabled = build.disabled = true;
  cancel.hidden = false;
  error.hidden = true;
  status.textContent = "Starting converter…";
  worker.onerror = () => {
    if (active === worker) finish("", "The converter stopped unexpectedly.");
  };
  worker.onmessage = ({ data }: MessageEvent<ConverterReply>) => {
    if (active !== worker) return;
    if (data.type === "progress") status.textContent = data.message;
    else if (data.type === "error") finish("", data.message);
    else {
      worker.terminate();
      active = undefined;
      cancel.hidden = true;
      status.textContent = "Verifying and saving the mod…";
      void installMod(new Blob([data.bytes]), true)
        .then(() => {
          modDisc.value = baseDisc.value = "";
          finish();
          void libraryStore.refresh();
          void navigator.storage?.persist().catch(() => undefined);
        })
        .catch((error: unknown) =>
          finish("", error instanceof Error ? error.message : String(error)),
        );
    }
  };
  worker.postMessage(request satisfies ConverterRequest);
};

void (async () => {
  const converter = await loadTm3Converter(location.origin);
  if (!converter) throw Error("TM3 is unavailable in this site build.");
  const { directory, release } = converter;
  available = {
    converter: new URL("converter.js", directory).href,
    runtime: release.runtime,
    version: release.version,
  };
  finish(`Converter ${release.version}`);
})().catch((error: unknown) => finish("", error instanceof Error ? error.message : String(error)));
