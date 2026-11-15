import type { RoomMode } from "../types.ts";
import { tournamentRules } from "./rules.ts";
import { tournamentControls } from "./selectors.ts";
import { tournamentSettings } from "./settings.ts";
import { tournamentChoosing } from "./state.ts";
import { tournamentSelectionStatus } from "./status.ts";
export const tournament: RoomMode = {
  rules: tournamentRules,
  settings: tournamentSettings,
  createControls(store, send) {
    return {
      reset(previous) {
        const selectionId =
          store.getState().tournament.selectionId ?? previous.tournament.selectionId;
        store.getState().closeTournamentSelection();
        if (selectionId) send({ action: "car-selection", requestId: selectionId, enabled: false });
      },
      selected(requestId, car) {
        void store.getState().engineCarSelected(requestId, car);
      },
      sync(previous) {
        const state = store.getState();
        const previousId = previous.tournament.selectionId;
        if (previousId && previousId !== state.tournament.selectionId)
          send({ action: "car-selection", requestId: previousId, enabled: false });
        if (!tournamentChoosing(state)) {
          if (state.tournament.selectionId)
            send({
              action: "car-selection",
              requestId: state.tournament.selectionId,
              enabled: false,
            });
          state.closeTournamentSelection();
          return;
        }
        const selectionId = state.openTournamentSelection();
        if (!selectionId) return;
        if (!state.tournament.selectionId)
          send({ action: "car-selection", requestId: selectionId, enabled: true });
        const status = tournamentSelectionStatus(store.getState());
        const signature = JSON.stringify(status);
        if (store.getState().tournament.sentStatus !== signature) {
          store.getState().tournamentStatusSent(signature);
          send({ action: "car-selection-status", requestId: selectionId, status });
        }
      },
      render() {
        const state = store.getState();
        const view = tournamentControls(state);
        if (!view) return;
        document.getElementById("room-car")!.closest("label")!.hidden = true;
        document.getElementById("room-ready")!.hidden = true;
        document.getElementById("match-help")!.textContent =
          "Each player loads their own disc, chooses a car in the game and presses Done. Back cancels the choice. The host prepares the server and starts once both players have confirmed.";
        document.getElementById("match-status")!.textContent = view.matchStatus;
        if (view.selectionStatus) {
          const status = view.selectionStatus;
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
