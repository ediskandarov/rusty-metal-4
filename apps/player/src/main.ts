import { joinMatch } from "@tm4/game-runtime/network/match";
import { hasNetworkEngine } from "@tm4/game-runtime/network/protocol";
import { startGame } from "@tm4/game-runtime/runtime/start";
import { assembleMods } from "@tm4/mods/assembly";
import { loadEnabledMods } from "@tm4/mods/library";
import { getBuildManifest } from "@tm4/mr-preparation";
import { loadDisc } from "@tm4/resources/loader/loader";
import { directorySources, remoteSources } from "@tm4/resources/loader/sources";
import type { DiscSources } from "@tm4/resources/loader/types";

import { prepareIsolation } from "./isolation.ts";
import { loadApprovedModModules } from "./mods/trusted.ts";
import { inRoom, roomPlayerReady } from "./room.ts";
import { createControlsStore } from "./state/controls.ts";
import { createResourcesStore } from "./state/resources.ts";
import { createStartupStore, type DiscSource } from "./state/startup.ts";
import { carLobby } from "./ui/car-lobby.ts";
import { element } from "./ui/dom.ts";
import { initializeFullscreen } from "./ui/fullscreen.ts";
import { matchStatus } from "./ui/match-status.ts";
import { initializeMouseLook } from "./ui/mouse-look.ts";
import { initializePopups } from "./ui/popups.ts";
import { initializeResources } from "./ui/resources.ts";
import { initializeSettings } from "./ui/settings.ts";
import { initializeStartup } from "./ui/startup.ts";
import { initializeTroubleshoot } from "./ui/troubleshoot.ts";

const endpoint = new URLSearchParams(location.search).get("match");
const networkGame = inRoom || !!endpoint;
document.documentElement.classList.toggle("network-game", networkGame);

const folderPicker = element("disc-folder", HTMLInputElement);
const skipMods = document.querySelector<HTMLInputElement>("#skip-mods");
const canvas = element("canvas", HTMLCanvasElement);
const controls = createControlsStore();
initializeMouseLook(canvas, controls);
initializeFullscreen(canvas);
const popups = initializePopups();
initializeTroubleshoot();
const resources = createResourcesStore();
const resourcesView = initializeResources(resources);
const startup = createStartupStore();
initializeStartup(startup, resourcesView, popups);
const { browserReady, begin, reportProgress, prepareMods, startRuntime, complete, fail } =
  startup.getState();

function warn(message: string) {
  startup.getState().warn(message);
  console.warn(message);
}

interface DiscSelection {
  sources: DiscSources;
  warnings?: readonly string[];
}

async function launch(
  resolveSources: () => DiscSelection | Promise<DiscSelection>,
  source: DiscSource = "folder",
) {
  if (!begin(source)) return;
  try {
    const selectedMods =
      TM4_MOD_LIBRARY && !networkGame && !skipMods?.checked ? await loadEnabledMods() : [];
    const { sources, warnings: messages } = await resolveSources();
    startup.getState().loadDisc(messages);
    messages?.forEach((message) => console.warn(message));
    await resources.getState().inspect(sources);
    const assets = await loadDisc(sources, {
      progress: reportProgress,
      warn,
    });
    prepareMods();
    const manifest = await getBuildManifest(new URL("simulation-build.json", document.baseURI));
    try {
      await assembleMods(assets, selectedMods, manifest.sha256);
      const approvedModules = selectedMods.length
        ? await loadApprovedModModules(manifest.sha256)
        : undefined;
      element("active-mods", HTMLElement).textContent = selectedMods.length
        ? selectedMods.map(({ manifest }) => `${manifest.name} ${manifest.version}`).join(", ")
        : "No active mods.";

      startRuntime();
      const status = element("status", HTMLElement);
      const showMatchStatus = matchStatus(status);
      if (networkGame) {
        showMatchStatus("lobby", "Preparing network player…");
      }
      const runtime = await startGame(assets, canvas, {
        resourceMods: selectedMods.length,
        manifest,
        approvedModules,
        session: inRoom,
        beforeMain: (module) => initializeSettings(module, canvas, controls),
      });
      if (inRoom) {
        if (!hasNetworkEngine(runtime))
          throw new Error("This build does not include the network runtime");
        await roomPlayerReady(runtime, sources);
      } else if (endpoint) {
        if (!hasNetworkEngine(runtime))
          throw new Error("This build does not include the network runtime");
        void joinMatch(runtime, endpoint, showMatchStatus, carLobby()).catch((error: unknown) => {
          showMatchStatus("error", error instanceof Error ? error.message : String(error));
        });
      } else {
        status.textContent = "";
      }
      complete();
      if (!new URLSearchParams(location.search).has("preview")) canvas.focus();
    } finally {
      manifest.free();
    }
  } catch (error) {
    fail(error);
    console.error(error);
  }
}

folderPicker.addEventListener("change", () => {
  const files = folderPicker.files;
  if (!files?.length) return;
  const selection = [...files];
  folderPicker.value = "";
  void launch(() => ({ sources: directorySources(selection) }));
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("pointerdown", () => canvas.focus());

try {
  if (!crossOriginIsolated && (!isSecureContext || !("serviceWorker" in navigator)))
    throw new Error("This game needs HTTPS and a browser with service worker support.");
  await prepareIsolation();
  if (crossOriginIsolated) browserReady();
} catch (error) {
  fail(error);
}

if (TM4_DEV && crossOriginIsolated) {
  void launch(async () => {
    try {
      return await remoteSources(new URL("/__dev/disc.json", location.href));
    } catch (error) {
      throw new Error(
        `Local disc unavailable. You can select a disc folder instead.\n${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }, "dev-server");
}
