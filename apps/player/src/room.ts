import { joinMatch } from "@tm4/game-runtime/network/match";
import type { NetworkPort } from "@tm4/game-runtime/network/protocol";
import type { GameModule } from "@tm4/game-runtime/runtime/module";
import { selectTournamentCar } from "@tm4/game-runtime/tournament/selection";
import type { DiscSources } from "@tm4/resources/loader/types";
import { type PlayerEvent, type PlayerMessage, roomCommandSchema } from "@tm4/room-player-protocol";
import { createRoomsClient } from "@tm4/rooms-client";
import { roomIdSchema } from "@tm4/rooms-client/schemas";

import { createRoomSession } from "./room/session.ts";
import { uploadRoomResources } from "./room/upload.ts";
import { matchStatus } from "./ui/match-status.ts";

// Files stay in this frame; only the host's explicit preparation request uploads resources.
const roomId = new URLSearchParams(location.search).get("room");
export const inRoom = !!roomId && roomIdSchema.safeParse(roomId).success && parent !== window;
const notify = (value: PlayerEvent) => {
  if (!inRoom || !roomId) return;
  parent.postMessage(
    { type: "rm4-player", roomId, ...value } satisfies PlayerMessage,
    location.origin,
  );
};
let session: ReturnType<typeof createRoomSession> | undefined;
let selection: { id: string; stop: () => void } | null = null;
let playerEngine: GameModule | null = null;

export async function roomPlayerReady(engine: GameModule, sources: DiscSources): Promise<void> {
  if (!inRoom || !roomId) return;
  const port = (globalThis as typeof globalThis & { tm4Port: NetworkPort }).tm4Port;
  const deadline = Date.now() + 30_000;
  while (!port.catalog || !port.compatibility) {
    if (Date.now() >= deadline)
      throw new Error("The game catalog did not become ready. Reload and try again.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const view = matchStatus(document.getElementById("status")!);
  const show = (
    state: Parameters<typeof view>[0],
    message: string,
    sessionId: string | null = null,
  ) => {
    view(state, message);
    // Native selection owns its prompt; connection errors must remain visible.
    document.getElementById("status")!.hidden = !!selection && state !== "error";
    notify({ event: "status", message, sessionId });
  };
  const resources = createRoomsClient({ baseURL: new URL("/api/", location.href) });
  const id = roomId;
  selection?.stop();
  selection = null;
  document.getElementById("tournament-status")!.hidden = true;
  playerEngine = engine;
  session?.dispose();
  session = createRoomSession({
    show,
    reportUpload: notify,
    async join(command, signal, status) {
      const endpoint = new URL(command.endpoint, location.origin);
      endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      // Menu teardown is queued at a render boundary; never enter game loading
      // while its Asyncify frame still owns menu resources.
      while (port.menuReady) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      await joinMatch(engine, endpoint.href, status, () => {}, command.credential, signal);
    },
    upload: (sessionId, signal, progress) =>
      uploadRoomResources(sources, resources.resources(id, sessionId), signal, progress),
  });
  notify({ event: "loaded", compatibility: port.compatibility, cars: port.catalog.cars });
  show("lobby", "Disc loaded. Choose your car in the room.");
}
if (inRoom) {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== parent || event.origin !== location.origin) return;
    const parsed = roomCommandSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.roomId !== roomId) return;
    const command = parsed.data;
    if (command.action === "car-selection-status") {
      if (selection?.id !== command.requestId) return;
      const panel = document.getElementById("tournament-status")!;
      panel.hidden = false;
      panel.dataset.phase = command.status.phase;
      document.getElementById("tournament-status-title")!.textContent = command.status.title;
      document.getElementById("tournament-status-message")!.textContent = command.status.message;
      return;
    }
    if (command.action === "car-selection") {
      if (!playerEngine) return;
      if (!command.enabled) {
        if (selection?.id === command.requestId) {
          selection.stop();
          selection = null;
          document.getElementById("tournament-status")!.hidden = true;
          document.getElementById("status")!.hidden = false;
          matchStatus(document.getElementById("status")!)(
            "lobby",
            "Disc loaded. Choose your car in the room.",
          );
        }
        return;
      }
      if (selection?.id === command.requestId) return;
      selection?.stop();
      try {
        const stop = selectTournamentCar(playerEngine, (car) => {
          if (selection?.id === command.requestId) {
            notify({ event: "car-selection", requestId: command.requestId, car });
          }
        });
        selection = { id: command.requestId, stop };
        document.getElementById("status")!.hidden = true;
      } catch (error) {
        selection = null;
        document.getElementById("tournament-status")!.hidden = true;
        document.getElementById("status")!.hidden = false;
        matchStatus(document.getElementById("status")!)("error", String(error));
      }
      return;
    }
    if (selection && command.action === "join") {
      selection.stop();
      selection = null;
      document.getElementById("tournament-status")!.hidden = true;
    }
    session?.handle(command);
  });
  window.addEventListener("pagehide", (event) => {
    // A cached page resumes through match.ts; a discarded frame must cancel all operations.
    if (!event.persisted) {
      selection?.stop();
      session?.dispose();
    }
  });
  notify({ event: "unloaded" });
}
