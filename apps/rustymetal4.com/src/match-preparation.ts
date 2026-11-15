import { matchPreparationControls } from "./state/match-preparation.ts";
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
  return () => {
    const controls = matchPreparationControls(store.getState());
    if (!controls) return;
    prepare.hidden = controls.prepare.hidden;
    prepare.disabled = controls.prepare.disabled;
    prepare.textContent = controls.prepare.label;
    cancel.hidden = controls.cancel.hidden;
    cancel.disabled = controls.cancel.disabled;
    start.hidden = controls.start.hidden;
    start.disabled = controls.start.disabled;
  };
}
