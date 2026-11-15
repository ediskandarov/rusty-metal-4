import { getBuildManifest } from "@tm4/lightyear-client";
import { playerMessageSchema, type RoomAction, type RoomCommand } from "@tm4/room-player-protocol";

import { matchPreparation } from "./match-preparation.ts";
import { renderMatchResults } from "./match-results.ts";
import { roomModes } from "./modes/index.ts";
import type { ModeControls } from "./modes/types.ts";
import { roomMember, type RoomStore } from "./state/room.ts";

export function roomMatch(id: string, store: RoomStore) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const frame = el<HTMLIFrameElement>("room-player");
  const reconnect = el<HTMLButtonElement>("reconnect-match");
  const journal = el<HTMLButtonElement>("download-server-journal");
  // These track deliveries to this frame, not a second copy of the room state.
  let delivered: { sessionId: string; action: "upload" | "join" } | null = null;
  let modeId: keyof typeof roomModes | null = null;
  let mode: ModeControls | null = null;
  const resetMode = () => {
    mode?.reset();
    mode = null;
    modeId = null;
  };
  const send = (value: RoomAction) =>
    frame.contentWindow?.postMessage(
      { type: "rm4-room", roomId: id, ...value } satisfies RoomCommand,
      location.origin,
    );
  const prepare = matchPreparation(store, (sessionId) => {
    delivered = { sessionId, action: "upload" };
    send({ action: "upload", sessionId });
  });
  const enter = () => {
    const { room, disc } = store.getState();
    const match = room?.match;
    if (!disc || !match?.endpoint || !match.credential) return;
    if (delivered?.sessionId === match.id && delivered.action === "join") return;
    delivered = { sessionId: match.id, action: "join" };
    send({
      action: "join",
      sessionId: match.id,
      endpoint: match.endpoint,
      credential: match.credential,
    });
  };
  const render = () => {
    const state = store.getState();
    const { room, disc, operation } = state;
    const self = roomMember(state);
    const viewingResults = renderMatchResults(state);
    el("match-panel").hidden = !self || !!room?.closed || state.departed || viewingResults;
    el("player-status").textContent =
      state.errors.player ??
      (state.runtime === "unavailable"
        ? "The game player is unavailable in this build."
        : state.playerStatus);
    el("server-journal-status").textContent = state.journal.message;
    if (!room || !self || room.closed || state.departed) {
      resetMode();
      frame.hidden = true;
      frame.removeAttribute("src");
      delivered = null;

      return;
    }
    if (state.runtime === "available" && !frame.hasAttribute("src")) {
      frame.src = "/play/?room=" + id;
      frame.hidden = false;
    }
    const match = room.match;
    // A refreshed snapshot can skip the old match's final room update.
    // Stop its player session before asking the same engine to open the menu.
    if (
      delivered &&
      (delivered.sessionId !== match?.id || (delivered.action === "join" && !match.endpoint))
    ) {
      send({ action: "stop", sessionId: delivered.sessionId, message: room.notice });
      delivered = null;
    }
    if (modeId !== room.modeId) {
      resetMode();
      modeId = room.modeId;
      mode = roomModes[modeId].createControls(store, send);
    }
    mode!.render();
    prepare(roomModes[room.modeId].minimumPlayers);
    journal.hidden = !(match || room.journal);
    journal.disabled = state.journal.downloading;
    const busy = operation !== null;
    reconnect.hidden = !match?.endpoint;
    reconnect.disabled = !disc || busy;
    enter();
  };
  const unsubscribe = store.subscribe(render);
  render();
  void getBuildManifest(new URL("/play/simulation-build.json", location.href)).then(
    () => store.getState().runtimeChecked(true),
    () => store.getState().runtimeChecked(false),
  );
  el("return-to-room").onclick = () => store.getState().returnToRoom();
  journal.onclick = async () => {
    const result = await store.getState().downloadJournal();
    if (!result) return;
    const url = URL.createObjectURL(result.bytes);
    const link = document.createElement("a");
    link.href = url;
    link.download = "rustymetal4-server-" + result.matchId + ".tm4j";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  reconnect.onclick = () => {
    send({ action: "stop", sessionId: store.getState().room?.match?.id ?? null });
    delivered = null;
    enter();
  };
  const receive = (event: MessageEvent<unknown>) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const parsed = playerMessageSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.roomId !== id) return;
    const message = parsed.data;
    switch (message.event) {
      case "car-selection":
        mode?.selected?.(message.requestId, message.car);
        break;
      case "status":
        if (message.sessionId === (store.getState().room?.match?.id ?? null))
          store.getState().playerReported(message.message);
        break;
      case "unloaded":
        resetMode();
        delivered = null;
        store.getState().playerLoaded(null);
        break;
      case "loaded":
        store.getState().playerLoaded({ compatibility: message.compatibility, cars: message.cars });
        break;
    }
  };
  window.addEventListener("message", receive);
  return () => {
    unsubscribe();
    resetMode();
    window.removeEventListener("message", receive);
  };
}
