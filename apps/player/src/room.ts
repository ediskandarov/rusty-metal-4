import { joinMatch } from "@tm4/game-runtime/network/match";
import type { NetworkEngine, NetworkPort } from "@tm4/game-runtime/network/protocol";
import { loadDisc } from "@tm4/resources/loader/loader";
import type { DiscSources } from "@tm4/resources/loader/types";
import { type PlayerEvent, type PlayerMessage, roomCommandSchema } from "@tm4/room-player-protocol";
import { createRoomsClient } from "@tm4/rooms-client";
import { roomIdSchema } from "@tm4/rooms-client/schemas";

import { matchStatus } from "./ui/match-status.ts";

// The existing player is embedded by its same-origin room. Files stay in this frame;
// only the host's explicit preparation request uploads the native manifest's resources.
const roomId = new URLSearchParams(location.search).get("room");
export const inRoom = !!roomId && roomIdSchema.safeParse(roomId).success && parent !== window;
const notify = (value: PlayerEvent) => {
  if (!inRoom || !roomId) return;
  parent.postMessage(
    { type: "rm4-player", roomId, ...value } satisfies PlayerMessage,
    location.origin,
  );
};
let engine: NetworkEngine | undefined;
let sources: DiscSources | undefined;
let stop: (() => void) | undefined;
let active: string | null = null;
let connecting = false;
let uploading = false;
let preparationStatus: string | undefined;
const status = (message: string, state: "lobby" | "playing" | "error" = "lobby") => {
  matchStatus(document.getElementById("status")!)(state, message);
  notify({ event: "status", message });
};
export async function roomPlayerReady(
  runtime: NetworkEngine,
  localSources: DiscSources,
): Promise<void> {
  engine = runtime;
  sources = localSources;
  const port = (globalThis as typeof globalThis & { tm4Port: NetworkPort }).tm4Port;
  const deadline = Date.now() + 30_000;
  while (!port.catalog || !port.compatibility) {
    if (Date.now() >= deadline)
      throw new Error("The game catalog did not become ready. Reload and try again.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  notify({ event: "loaded", compatibility: port.compatibility, cars: port.catalog.cars });
  status("Disc loaded. Choose your car in the room.");
}
if (inRoom) {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== parent || event.origin !== location.origin) return;
    const parsed = roomCommandSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.roomId !== roomId) return;
    const message = parsed.data;
    if (message.action === "status") {
      preparationStatus = message.message;
      if (sources && !uploading && !active) status(message.message);
    } else if (message.action === "stop") {
      active = null;
      stop?.();
      stop = undefined;
      status(message.message || "Back in the room. Ready when you are.");
    } else if (message.action === "join" && engine && !connecting && active !== message.sessionId) {
      const endpoint = new URL(message.endpoint, location.origin);
      endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      active = message.sessionId;
      connecting = true;
      void joinMatch(
        engine,
        endpoint.href,
        (state, text) => status(text, state),
        () => {},
        message.credential,
      )
        .then((close) => {
          if (active === message.sessionId) stop = close;
          else close();
        })
        .catch((error) => {
          active = null;
          status(String(error));
        })
        .finally(() => {
          connecting = false;
        });
    } else if (message.action === "upload" && sources && !uploading) {
      uploading = true;
      preparationStatus = undefined;
      const resources = createRoomsClient({ baseURL: new URL("/api/", location.href) }).resources(
        roomId,
        message.sessionId,
      );
      void (async () => {
        const required = await resources.resources();
        const assets = await loadDisc(sources, { progress: status });
        for (const [index, id] of [
          ...required.map((entry) => entry.id),
          "/DATA/files.tsv",
        ].entries()) {
          const bytes = assets.files.get(id);
          if (!bytes) throw new Error("Missing required server resource: " + id);
          status(
            "Uploading private server resources (" +
              (index + 1) +
              "/" +
              (required.length + 1) +
              ")…",
          );
          await resources.upload(id, bytes);
        }
        assets.files.clear();
        await resources.prepare();
      })().then(
        () => {
          uploading = false;
          if (!active)
            status(preparationStatus ?? "Server upload complete. Waiting for validation…");
        },
        (error) => {
          uploading = false;
          status(String(error));
        },
      );
    }
  });
  notify({ event: "unloaded" });
}
