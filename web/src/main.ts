import { loadDisc } from "./loader/loader.ts";
import { localSources, remoteSources } from "./loader/sources.ts";
import type { DiscSources } from "./loader/types.ts";
import { joinMatch } from "./network/match.ts";
import { hasNetworkEngine } from "./network/protocol.ts";
import { startGame } from "./runtime/start.ts";
import { element } from "./ui/dom.ts";

const startup = element("startup", HTMLElement);
const progress = element("startup-progress", HTMLElement);
const warnings = element("startup-warnings", HTMLElement);
const picker = element("disc-files", HTMLInputElement);
const canvas = element("canvas", HTMLCanvasElement);
let starting = false;
let runtimeStarted = false;

function warn(message: string) {
  const line = document.createElement("li");
  line.textContent = message;
  warnings.append(line);
  console.warn(message);
}

async function launch(sources: DiscSources) {
  if (starting) return;
  starting = true;
  picker.disabled = true;
  try {
    if (!crossOriginIsolated)
      throw new Error("This page needs cross-origin isolation headers to run the game.");
    const assets = await loadDisc(sources, {
      progress: (message) => {
        progress.textContent = message;
      },
      warn,
    });
    progress.textContent = "Starting game…";
    runtimeStarted = true;
    // Hide before starting SDL so its initial viewport uses the final page layout.
    startup.hidden = true;
    await startGame(assets, canvas);
    const status = element("status", HTMLElement);
    status.textContent = "";
    const endpoint = new URLSearchParams(location.search).get("match");
    if (endpoint) {
      const runtime = globalThis.Module;
      if (!hasNetworkEngine(runtime))
        throw new Error("This build does not include the network runtime");
      void joinMatch(runtime, endpoint, status).catch((error: unknown) => {
        status.textContent = error instanceof Error ? error.message : String(error);
      });
    }
    if (!new URLSearchParams(location.search).has("preview")) canvas.focus();
  } catch (error) {
    startup.hidden = false;
    const message = error instanceof Error ? error.message : String(error);
    progress.textContent = runtimeStarted ? `${message}\nReload the page to try again.` : message;
    console.error(error);
  } finally {
    starting = runtimeStarted;
    picker.disabled = runtimeStarted;
  }
}

picker.addEventListener("change", () => {
  warnings.replaceChildren();
  if (picker.files?.length) void launch(localSources(picker.files));
});
canvas.addEventListener("pointerdown", () => canvas.focus());

if (TM4_DEV) {
  progress.textContent = "Connecting to local disc server…";
  try {
    const { sources, warnings: messages } = await remoteSources("/__dev/disc.json");
    messages.forEach(warn);
    await launch(sources);
  } catch (error) {
    progress.textContent = `Local disc unavailable. You can select files instead.\n${error instanceof Error ? error.message : String(error)}`;
  }
}
