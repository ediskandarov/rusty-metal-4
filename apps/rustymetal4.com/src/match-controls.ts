import { getBuildManifest } from "@tm4/lightyear-client";
import { playerMessageSchema, type RoomAction, type RoomCommand } from "@tm4/room-player-protocol";

import { roomCarChoices, roomMember, roomSelectedCar, type RoomStore } from "./state/room.ts";

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
  let delivered: { sessionId: string; action: "upload" | "join" } | null = null;
  let sentStatus: string | null = null;
  const send = (value: RoomAction) =>
    frame.contentWindow?.postMessage(
      { type: "rm4-room", roomId: id, ...value } satisfies RoomCommand,
      location.origin,
    );
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
    const result = room?.result;
    const viewingResults = !!result && state.returnedResult !== result.matchId;
    el("results-panel").hidden = !result || !self || state.departed || !!room?.closed;
    el("return-to-room").hidden = !viewingResults;
    if (result) {
      const reason =
        result.completion.reasons === 3
          ? "Time and frag limits reached"
          : result.completion.reasons === 2
            ? "Frag limit reached"
            : "Time limit reached";
      const winners = result.participants.filter((row) => row.winner);
      el("results-reason").textContent =
        reason +
        " · " +
        (winners.length > 1
          ? "Tied winners: "
          : winners.length
            ? "Winner: "
            : "No remaining participants") +
        winners.map((row) => row.name).join(", ");
      el("results-rows").replaceChildren(
        ...[...result.participants]
          .sort((a, b) => b.score.frags - a.score.frags || a.identity.slot - b.identity.slot)
          .map((row) => {
            const tr = document.createElement("tr");
            tr.dataset.participant = row.identity.participant;
            tr.dataset.member = row.memberId;
            for (const value of [
              row.name,
              row.score.frags,
              row.score.deaths,
              row.winner ? (winners.length > 1 ? "Tied winner" : "Winner") : "",
            ]) {
              const td = document.createElement("td");
              td.textContent = String(value);
              tr.append(td);
            }
            return tr;
          }),
      );
    }
    el("match-panel").hidden = !self || !!room?.closed || state.departed || viewingResults;
    el("player-status").textContent =
      state.errors.player ??
      (state.runtime === "unavailable"
        ? "The game player is unavailable in this build."
        : state.playerStatus);
    el("server-journal-status").textContent = state.journal.message;
    if (!room || !self || room.closed || state.departed) {
      frame.hidden = true;
      frame.removeAttribute("src");
      delivered = null;
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
    if (
      delivered &&
      (delivered.sessionId !== match?.id || (delivered.action === "join" && !match.endpoint))
    ) {
      send({ action: "stop", sessionId: delivered.sessionId, message: room.notice });
      delivered = null;
    }
    const status =
      disc && !match?.endpoint
        ? match?.message || room.notice || "Disc loaded. Choose your car in the room."
        : null;
    if (status !== sentStatus) {
      sentStatus = status;
      if (status) send({ action: "status", sessionId: match?.id ?? null, message: status });
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
      room.participants.length < 1 ||
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
  car.onchange = () => {
    void store.getState().selectCar(car.value);
  };
  ready.onclick = () => {
    void store.getState().toggleReady();
  };
  prepare.onclick = async () => {
    const sessionId = await store.getState().prepare();
    const match = store.getState().room?.match;
    if (sessionId && match?.id === sessionId && match.stage === "uploading") {
      delivered = { sessionId, action: "upload" };
      send({ action: "upload", sessionId });
    }
  };
  cancel.onclick = () => {
    void store.getState().cancel();
  };
  start.onclick = () => {
    void store.getState().start();
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
      case "status":
        if (message.sessionId === (store.getState().room?.match?.id ?? null))
          store.getState().playerReported(message.message);
        break;
      case "unloaded":
        delivered = null;
        sentStatus = null;
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
    window.removeEventListener("message", receive);
  };
}
