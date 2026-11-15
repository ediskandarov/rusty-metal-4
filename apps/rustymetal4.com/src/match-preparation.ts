import type { RoomStore } from "./state/room.ts";
export function matchPreparation(store: RoomStore, upload: (sessionId: string) => void) {
  const prepare = document.getElementById("prepare-match") as HTMLButtonElement;
  const start = document.getElementById("start-match") as HTMLButtonElement;
  const cancel = document.getElementById("cancel-preparation") as HTMLButtonElement;
  prepare.onclick = async () => {
    const sessionId = await store.getState().prepare();
    const match = store.getState().room?.match;
    if (sessionId && match?.id === sessionId && match.stage === "uploading") upload(sessionId);
  };
  cancel.onclick = () => {
    void store.getState().cancel();
  };
  start.onclick = () => {
    void store.getState().start();
  };
  return (minimumPlayers: number) => {
    const { room, disc, operation } = store.getState();
    if (!room) return;
    const match = room.match;
    const host = room.you === room.hostId;
    const busy = operation !== null;
    const locked =
      !!match && ["starting", "connecting", "playing", "stopping"].includes(match.stage);
    prepare.hidden = !host || (!!match && match.stage !== "uploading");
    prepare.disabled = busy || !disc;
    prepare.textContent = match ? "Resume resource upload" : "Prepare server from my disc";
    cancel.hidden = !host || !match || locked;
    cancel.disabled = busy;
    start.hidden = !host || match?.stage !== "ready";
    start.disabled =
      busy ||
      room.participants.length < minimumPlayers ||
      room.participants.some((member) => !member.ready || !member.connected);
  };
}
