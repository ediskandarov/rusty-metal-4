import { joinMatch } from "@tm4/game-runtime/network/match";
import type { NetworkEngine, NetworkPort } from "@tm4/game-runtime/network/protocol";
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

export async function roomPlayerReady(engine: NetworkEngine, sources: DiscSources): Promise<void> {
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
    notify({ event: "status", message, sessionId });
  };
  const resources = createRoomsClient({ baseURL: new URL("/api/", location.href) });
  const id = roomId;
  session?.dispose();
  session = createRoomSession({
    show,
    async join(command, signal, status) {
      const endpoint = new URL(command.endpoint, location.origin);
      endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
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
    if (parsed.success && parsed.data.roomId === roomId) session?.handle(parsed.data);
  });
  window.addEventListener("pagehide", (event) => {
    // A cached page resumes through match.ts; a discarded frame must cancel all operations.
    if (!event.persisted) session?.dispose();
  });
  notify({ event: "unloaded" });
}
