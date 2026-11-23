import type { CarSelectionStatus } from "@tm4/room-player-protocol";

import type { RoomStore } from "../../state/room.ts";
import type { ModeControls, RoomState, SendPlayerAction } from "../types.ts";
import { carSelectionAvailable } from "./state.ts";

export function createCarSelectionControls(
  store: RoomStore,
  send: SendPlayerAction,
  statusFor: (state: RoomState) => CarSelectionStatus,
  help: string,
): ModeControls {
  return {
    reset(previous) {
      const selectionId =
        store.getState().carSelection.selectionId ?? previous.carSelection.selectionId;
      store.getState().closeCarSelection();
      if (selectionId) send({ action: "car-selection", requestId: selectionId, enabled: false });
    },
    selected(requestId, car) {
      void store.getState().engineCarSelected(requestId, car);
    },
    sync(previous) {
      const state = store.getState();
      const previousId =
        previous.room?.modeId === state.room?.modeId ? previous.carSelection.selectionId : null;
      if (previousId && previousId !== state.carSelection.selectionId)
        send({ action: "car-selection", requestId: previousId, enabled: false });
      if (!carSelectionAvailable(state)) {
        if (state.carSelection.selectionId)
          send({
            action: "car-selection",
            requestId: state.carSelection.selectionId,
            enabled: false,
          });
        state.closeCarSelection();
        return;
      }
      const selectionId = state.openCarSelection();
      if (!selectionId) return;
      if (!state.carSelection.selectionId)
        send({ action: "car-selection", requestId: selectionId, enabled: true });
      const status = statusFor(store.getState());
      const signature = JSON.stringify(status);
      if (store.getState().carSelection.sentStatus !== signature) {
        store.getState().carSelectionStatusSent(signature);
        send({ action: "car-selection-status", requestId: selectionId, status });
      }
    },
    render() {
      const state = store.getState();
      document.getElementById("match-help")!.textContent = help;
      if (state.carSelection.selectionId) {
        const status = statusFor(state);
        document.getElementById("player-status")!.textContent =
          status.title + ". " + status.message;
      }
    },
  };
}
