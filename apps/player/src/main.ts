import { joinMatch } from "@tm4/game-runtime/network/match";
import { hasNetworkEngine } from "@tm4/game-runtime/network/protocol";
import { startGame } from "@tm4/game-runtime/runtime/start";
import { loadDisc } from "@tm4/resources/loader/loader";
import { directorySources, remoteSources } from "@tm4/resources/loader/sources";
import type { DiscSources } from "@tm4/resources/loader/types";
import { installCarMods } from "@tm4/resources/mods/install";

import { prepareIsolation } from "./isolation.ts";
import { inRoom, roomPlayerReady } from "./room.ts";
import { createResourcesStore } from "./state/resources.ts";
import { createStartupStore, type DiscSource, runtimeWasStarted } from "./state/startup.ts";
import { carLobby } from "./ui/car-lobby.ts";
import { element } from "./ui/dom.ts";
import { initializeFullscreen } from "./ui/fullscreen.ts";
import { matchStatus } from "./ui/match-status.ts";
import { initializeMods } from "./ui/mods.ts";
import { initializePopups } from "./ui/popups.ts";
import { initializeResources } from "./ui/resources.ts";
import { initializeSettings } from "./ui/settings.ts";
import { initializeStartup } from "./ui/startup.ts";
import { initializeTroubleshoot } from "./ui/troubleshoot.ts";

const folderPicker = element("disc-folder", HTMLInputElement);
const canvas = element("canvas", HTMLCanvasElement);
initializeFullscreen(canvas);
const popups = initializePopups();
initializeTroubleshoot();
const resources = createResourcesStore();
const resourcesView = initializeResources(resources);
const mods = initializeMods();
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
    const selectedMods = await mods.beginSession();
    const { sources, warnings: messages } = await resolveSources();
    startup.getState().loadDisc(messages);
    messages?.forEach((message) => console.warn(message));
    await resources.getState().inspect(sources);
    const assets = await loadDisc(sources, {
      progress: reportProgress,
      warn,
    });
    prepareMods();
    await installCarMods(assets, selectedMods);
    startRuntime();
    const endpoint = new URLSearchParams(location.search).get("match");
    const status = element("status", HTMLElement);
    const showMatchStatus = matchStatus(status);
    if (endpoint || inRoom) {
      showMatchStatus("lobby", "Preparing Deathmatch…");
    }
    const runtime = await startGame(assets, canvas, {
      resourceMods: selectedMods.length,
      session: inRoom,
      beforeMain: (module) => initializeSettings(module, canvas),
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
  } catch (error) {
    fail(error);
    console.error(error);
  } finally {
    mods.finishStartup(runtimeWasStarted(startup.getState().phase));
  }
}

folderPicker.addEventListener("change", () => {
  const files = folderPicker.files;
  if (files?.length) void launch(() => ({ sources: directorySources(files) }));
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
