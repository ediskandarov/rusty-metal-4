import { getBuildManifest } from "@tm4/lightyear-client";
import { createRoomsClient } from "@tm4/rooms-client";
import type { Compatibility, RoomSnapshot } from "@tm4/rooms-client/schemas";

interface PlayerMessage {
  type: "rm4-player";
  roomId: string;
  status?: string;
  loaded?: boolean;
  compatibility?: Compatibility;
  cars?: string[];
}

export function matchControls(id: string, apply: (room: RoomSnapshot) => void) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const frame = el<HTMLIFrameElement>("room-player");
  const car = el<HTMLSelectElement>("room-car");
  const ready = el<HTMLButtonElement>("room-ready");
  const prepare = el<HTMLButtonElement>("prepare-match");
  const start = el<HTMLButtonElement>("start-match");
  const cancel = el<HTMLButtonElement>("cancel-preparation");
  const reconnect = el<HTMLButtonElement>("reconnect-match");
  const journal = el<HTMLButtonElement>("download-server-journal");
  let downloading = false;
  let current: RoomSnapshot | undefined;
  let compatibility: Compatibility | null = null;
  let cars: string[] = [];
  let sentSession: string | null = null;
  let busy = false;
  let runtimeAvailable: boolean | null = null;
  const send = (value: object) =>
    frame.contentWindow?.postMessage({ type: "rm4-room", roomId: id, ...value }, location.origin);
  const rooms = createRoomsClient({ baseURL: new URL("/api/", location.href) });
  const update = async (operation: Promise<RoomSnapshot>) => {
    const room = await operation;
    apply(room);
    return room;
  };
  const action = (operation: () => Promise<unknown>) => {
    if (busy) return;
    busy = true;
    void operation()
      .catch((error) => {
        el("player-status").textContent = String(error);
      })
      .finally(() => {
        busy = false;
        if (current) render(current);
      });
  };
  const player = (isReady: boolean) =>
    update(rooms.player(id, { car: car.value || null, compatibility, ready: isReady }));
  const enter = () => {
    const match = current?.match;
    if (!compatibility || !match?.endpoint || !match.credential || sentSession === match.id) return;
    sentSession = match.id;
    send({
      action: "join",
      sessionId: match.id,
      endpoint: match.endpoint,
      credential: match.credential,
    });
  };
  const render = (room: RoomSnapshot) => {
    current = room;
    el("match-panel").hidden = !room.you;
    if (!room.you) {
      frame.hidden = true;
      frame.removeAttribute("src");
      compatibility = null;
      sentSession = null;
      return;
    }
    if (runtimeAvailable && !frame.hasAttribute("src")) {
      frame.src = "/play/?room=" + id;
      frame.hidden = false;
    }
    const self = room.participants.find((member) => member.id === room.you)!;
    const host = room.you === room.hostId;
    const match = room.match;
    journal.hidden = !host || !(match || room.journal);
    journal.disabled = downloading;
    const locked =
      !!match && ["starting", "connecting", "playing", "stopping"].includes(match.stage);
    el("match-status").textContent =
      match?.message || room.notice || "Load your disc, then the host can prepare the server.";
    if (
      car.options.length !== cars.length ||
      cars.some((name, index) => car.options[index]?.value !== name)
    )
      car.replaceChildren(...cars.map((name) => new Option(name, name)));
    if (self.car && cars.includes(self.car)) car.value = self.car;
    car.disabled = busy || !compatibility || locked;
    ready.disabled = busy || !compatibility || match?.stage !== "ready" || !self.car;
    ready.textContent = self.ready ? "Not ready" : "Ready";
    prepare.hidden = !host || (!!match && match.stage !== "uploading");
    prepare.disabled = busy || !compatibility;
    prepare.textContent = match ? "Resume resource upload" : "Prepare server from my disc";
    cancel.hidden = !host || !match || locked;
    cancel.disabled = busy;
    start.hidden = !host || match?.stage !== "ready";
    start.disabled =
      busy ||
      room.participants.length < 2 ||
      room.participants.some((member) => !member.ready || !member.connected);
    reconnect.hidden = !match?.endpoint;
    reconnect.disabled = !compatibility || busy;
    if (!match && sentSession) {
      send({ action: "stop", message: room.notice });
      sentSession = null;
    }
    enter();
  };
  void getBuildManifest(new URL("/play/simulation-build.json", location.href))
    .then(() => {
      runtimeAvailable = true;
    })
    .catch(() => {
      runtimeAvailable = false;
    })
    .finally(() => {
      if (current) render(current);
      if (!runtimeAvailable)
        el("player-status").textContent = "The game player is unavailable in this build.";
    });
  journal.onclick = async () => {
    const matchId = current?.match?.id ?? current?.journal?.matchId;
    if (!matchId || downloading) return;
    downloading = true;
    journal.disabled = true;
    const status = el("server-journal-status");
    status.textContent = "Downloading server journal…";
    try {
      const result = await rooms.journal(id, matchId);
      const url = URL.createObjectURL(result.bytes);
      const link = document.createElement("a");
      link.href = url;
      link.download = "rustymetal4-server-" + matchId + ".tm4j";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent =
        "Journal saved through " +
        new Date(result.savedAt).toLocaleTimeString() +
        ". Archives remain available for 24 hours while this room exists.";
    } catch (error) {
      status.textContent = String(error);
    } finally {
      downloading = false;
      if (current) render(current);
    }
  };
  car.addEventListener("change", () => action(() => player(false)));
  ready.onclick = () =>
    action(() => player(!current?.participants.find((member) => member.id === current.you)?.ready));
  prepare.onclick = () =>
    action(async () => {
      const room = current?.match ? current : await update(rooms.prepare(id));
      if (room.match) send({ action: "upload", sessionId: room.match.id });
    });
  cancel.onclick = () => action(() => update(rooms.cancel(id, current!.match!.id)));
  start.onclick = () => action(() => update(rooms.start(id)));
  reconnect.onclick = () => {
    send({ action: "stop" });
    sentSession = null;
    enter();
  };
  window.addEventListener("message", (event: MessageEvent<PlayerMessage | null>) => {
    if (
      event.origin !== location.origin ||
      event.source !== frame.contentWindow ||
      event.data?.type !== "rm4-player" ||
      event.data.roomId !== id
    )
      return;
    const message = event.data;
    if (typeof message.status === "string") el("player-status").textContent = message.status;
    if (typeof message.loaded === "boolean") {
      compatibility = message.loaded ? (message.compatibility ?? null) : null;
      cars = message.loaded ? (message.cars ?? []) : [];
      if (current) render(current);
      if (!current?.match?.endpoint && current?.you) action(() => player(false));
      enter();
    }
  });
  return render;
}
