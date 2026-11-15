import type { RoomMode } from "../types.ts";
import { tournamentSelectionStatus } from "./status.ts";
export const tournament: RoomMode = {
  minimumPlayers: 2,
  createControls(store, send) {
    let selectionId: string | null = null;
    let sentStatus: string | null = null;
    const reset = () => {
      if (selectionId) send({ action: "car-selection", requestId: selectionId, enabled: false });
      selectionId = null;
      sentStatus = null;
    };
    return {
      reset,
      selected(requestId, car) {
        if (selectionId === requestId) void store.getState().engineCarSelected(car);
      },
      render() {
        const state = store.getState();
        const { room, disc } = state;
        if (!room) return;
        const match = room.match;
        document.getElementById("room-car")!.closest("label")!.hidden = true;
        document.getElementById("room-ready")!.hidden = true;
        document.getElementById("match-help")!.textContent =
          "Each player loads their own disc, chooses a car in the game and presses Done. Back cancels the choice. The host prepares the server and starts once both players have confirmed.";
        document.getElementById("match-status")!.textContent =
          match?.message ||
          room.notice ||
          "Choose and confirm your car in the game below. The host prepares the server before starting the battle.";
        const choosing = !["starting", "connecting", "playing", "stopping", "finished"].includes(
          match?.stage ?? "",
        );
        if (disc && choosing && !selectionId) {
          selectionId = crypto.randomUUID();
          send({ action: "car-selection", requestId: selectionId, enabled: true });
        } else if (!disc || !choosing) reset();
        if (selectionId) {
          const status = tournamentSelectionStatus(state);
          const signature = JSON.stringify(status);
          if (sentStatus !== signature) {
            sentStatus = signature;
            send({ action: "car-selection-status", requestId: selectionId, status });
          }
          document.getElementById("player-status")!.textContent =
            status.title + ". " + status.message;
        }
      },
    };
  },
  results(result) {
    const won = result.completion.reasons === 4;
    return {
      summary: won
        ? "Tournament battle won · Team: " +
          result.participants
            .filter((row) => row.winner)
            .map((row) => row.name)
            .join(", ")
        : "Tournament battle lost",
      rows: [...result.participants]
        .sort((a, b) => a.identity.slot - b.identity.slot)
        .map((participant) => ({ participant, outcome: won ? "Victory" : "Defeat" })),
    };
  },
};
