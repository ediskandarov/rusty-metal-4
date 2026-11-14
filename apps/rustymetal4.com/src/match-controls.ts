import { getBuildManifest } from "@tm4/lightyear-client";
import type { Compatibility } from "@tm4/rooms-client/schemas";

import { roomCarChoices, roomMember, roomSelectedCar, type RoomStore } from "./state/room.ts";

interface PlayerMessage {
  type: "rm4-player";
  roomId: string;
  status?: string;
  loaded?: boolean;
  compatibility?: Compatibility;
  cars?: string[];
}

export function matchControls(id: string, store: RoomStore) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const frame = el<HTMLIFrameElement>("room-player");
  const car = el<HTMLSelectElement>("room-car");
  const ready = el<HTMLButtonElement>("room-ready");
  const prepare = el<HTMLButtonElement>("prepare-match");
  const start = el<HTMLButtonElement>("start-match");
  const cancel = el<HTMLButtonElement>("cancel-preparation");
  const reconnect = el<HTMLButtonElement>("reconnect-match");
  const journal = el<HTMLButtonElement>("download-server-journal");
  // These track deliveries to this frame, not a second copy of the room state.
  let sentSession: string | null = null;
  let sentStatus: string | null = null;
  const send = (value: object) =>
    frame.contentWindow?.postMessage({ type: "rm4-room", roomId: id, ...value }, location.origin);
  const enter = () => {
    const { room, disc } = store.getState();
    const match = room?.match;
    if (!disc || !match?.endpoint || !match.credential || sentSession === match.id) return;
    sentSession = match.id;
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
    el("match-panel").hidden = !self || !!room?.closed || state.departed;
    el("player-status").textContent =
      state.errors.player ??
      (state.runtime === "unavailable"
        ? "The game player is unavailable in this build."
        : state.playerStatus);
    el("server-journal-status").textContent = state.journal.message;
    if (!room || !self || room.closed || state.departed) {
      frame.hidden = true;
      frame.removeAttribute("src");
      sentSession = null;
      sentStatus = null;
      return;
    }
    if (state.runtime === "available" && !frame.hasAttribute("src")) {
      frame.src = "/play/?room=" + id;
      frame.hidden = false;
    }
    const busy = operation !== null;
    const host = room.you === room.hostId;
    const match = room.match;
    journal.hidden = !host || !(match || room.journal);
    journal.disabled = state.journal.downloading;
    const joining = match?.stage === "playing" && !match.endpoint;
    const locked =
      !!match &&
      ["starting", "connecting", "playing", "stopping"].includes(match.stage) &&
      !joining;
    const choices = roomCarChoices(state);
    el("match-status").textContent =
      match?.message || room.notice || "Load your disc, then the host can prepare the server.";
    if (!match?.endpoint && sentSession) {
      send({ action: "stop", message: room.notice });
      sentSession = null;
    }
    const status =
      disc && !match?.endpoint
        ? match?.message || room.notice || "Disc loaded. Choose your car in the room."
        : null;
    if (status !== sentStatus) {
      sentStatus = status;
      if (status) send({ action: "status", message: status });
    }
    if (
      car.options.length !== choices.length ||
      choices.some((name, index) => car.options[index]?.value !== name)
    )
      car.replaceChildren(...choices.map((name) => new Option(name, name)));
    car.value = roomSelectedCar(state) ?? "";
    car.disabled = busy || !disc || locked;
    ready.disabled = busy || !disc || (match?.stage !== "ready" && !joining) || !self.car;
    ready.textContent = joining ? "Join match" : self.ready ? "Not ready" : "Ready";
    prepare.hidden = !host || (!!match && match.stage !== "uploading");
    prepare.disabled = busy || !disc;
    prepare.textContent = match ? "Resume resource upload" : "Prepare server from my disc";
    cancel.hidden = !host || !match || locked;
    cancel.disabled = busy;
    start.hidden = !host || match?.stage !== "ready";
    start.disabled =
      busy ||
      room.participants.length < 2 ||
      room.participants.some((member) => !member.ready || !member.connected);
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
  car.onchange = () => {
    void store.getState().selectCar(car.value);
  };
  ready.onclick = () => {
    void store.getState().toggleReady();
  };
  prepare.onclick = async () => {
    const sessionId = await store.getState().prepare();
    if (sessionId) send({ action: "upload", sessionId });
  };
  cancel.onclick = () => {
    void store.getState().cancel();
  };
  start.onclick = () => {
    void store.getState().start();
  };
  reconnect.onclick = () => {
    send({ action: "stop" });
    sentSession = null;
    enter();
  };
  const receive = (event: MessageEvent<PlayerMessage | null>) => {
    if (
      event.origin !== location.origin ||
      event.source !== frame.contentWindow ||
      event.data?.type !== "rm4-player" ||
      event.data.roomId !== id
    )
      return;
    const message = event.data;
    if (typeof message.status === "string") store.getState().playerReported(message.status);
    if (typeof message.loaded === "boolean") {
      if (!message.loaded) {
        sentSession = null;
        sentStatus = null;
      }
      store
        .getState()
        .playerLoaded(
          message.loaded && message.compatibility
            ? { compatibility: message.compatibility, cars: message.cars ?? [] }
            : null,
        );
    }
  };
  window.addEventListener("message", receive);
  return () => {
    unsubscribe();
    window.removeEventListener("message", receive);
  };
}
