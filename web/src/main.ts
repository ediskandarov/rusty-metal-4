import { loadDisc } from "./loader/loader.ts";
import { directorySources, remoteSources } from "./loader/sources.ts";
import type { DiscSources } from "./loader/types.ts";
import { installCarMods } from "./mods/install.ts";
import { prepareIsolation } from "./runtime/isolation.ts";
import { startGame } from "./runtime/start.ts";
import { element } from "./ui/dom.ts";
import { initializeMods } from "./ui/mods.ts";
import { initializePopups } from "./ui/popups.ts";
import { initializeResources } from "./ui/resources.ts";

const startup = element("startup", HTMLElement);
const progress = element("startup-progress", HTMLElement);
const warnings = element("startup-warnings", HTMLElement);
const folderPicker = element("disc-folder", HTMLInputElement);
const canvas = element("canvas", HTMLCanvasElement);
initializePopups();
const resources = initializeResources();
const mods = initializeMods();
let starting = false;
let runtimeStarted = false;

function warn(message: string) {
  const line = document.createElement("li");
  line.textContent = message;
  warnings.append(line);
  console.warn(message);
}

async function launch(resolveSources: () => DiscSources) {
  if (starting) return;
  starting = true;
  folderPicker.disabled = true;
  try {
    const selectedMods = await mods.beginSession();
    const sources = resolveSources();
    await resources.inspect(sources);
    if (!crossOriginIsolated)
      throw new Error("This page needs cross-origin isolation headers to run the game.");
    const assets = await loadDisc(sources, {
      progress: (message) => {
        progress.textContent = message;
      },
      warn,
    });
    progress.textContent = "Preparing mods…";
    await installCarMods(assets, selectedMods);
    progress.textContent = "Starting game…";
    runtimeStarted = true;
    // Hide before starting SDL so its initial viewport uses the final page layout.
    startup.hidden = true;
    await startGame(assets, canvas);
    element("status", HTMLElement).textContent = "";
    if (!new URLSearchParams(location.search).has("preview")) canvas.focus();
  } catch (error) {
    startup.hidden = false;
    const message = error instanceof Error ? error.message : String(error);
    progress.textContent = runtimeStarted ? `${message}\nReload the page to try again.` : message;
    console.error(error);
  } finally {
    mods.finishStartup(runtimeStarted);
    starting = runtimeStarted;
    folderPicker.disabled = runtimeStarted;
  }
}

folderPicker.addEventListener("change", () => {
  warnings.replaceChildren();
  const files = folderPicker.files;
  if (files?.length) void launch(() => directorySources(files));
});
canvas.addEventListener("pointerdown", () => canvas.focus());

folderPicker.disabled = !crossOriginIsolated;
if (!crossOriginIsolated) {
  progress.textContent =
    isSecureContext && "serviceWorker" in navigator
      ? "Preparing browser support… The page will reload automatically. If it does not, allow service workers for this site and reload."
      : "This game needs HTTPS and a browser with service worker support.";
}

try {
  await prepareIsolation();
} catch (error) {
  progress.textContent = error instanceof Error ? error.message : String(error);
}

if (TM4_DEV && crossOriginIsolated) {
  progress.textContent = "Connecting to local disc server…";
  try {
    const { sources, warnings: messages } = await remoteSources("/__dev/disc.json");
    messages.forEach(warn);
    await launch(() => sources);
  } catch (error) {
    progress.textContent = `Local disc unavailable. You can select a disc folder instead.\n${error instanceof Error ? error.message : String(error)}`;
  }
}
