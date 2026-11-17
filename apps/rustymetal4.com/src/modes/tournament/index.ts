import { createCarSelectionControls } from "../car-selection/controls.ts";
import type { RoomMode } from "../types.ts";
import { tournamentSettings } from "./settings.ts";
import { tournamentSelectionStatus } from "./status.ts";
export const tournament: RoomMode = {
  settings: tournamentSettings,
  createControls(store, send) {
    return createCarSelectionControls(
      store,
      send,
      tournamentSelectionStatus,
      "Each player loads their own disc, chooses a car in the game and presses Done. Back cancels the choice. The host prepares the server and starts once all players have confirmed.",
    );
  },
  results(result) {
    const won = result.completion.reasons === 4;
    return {
      summary: won
        ? "Tournament won · Team: " +
          result.participants
            .filter((row) => row.winner)
            .map((row) => row.name)
            .join(", ")
        : "Tournament lost",
      rows: [...result.participants]
        .sort((a, b) => a.identity.slot - b.identity.slot)
        .map((participant) => ({ participant, outcome: won ? "Victory" : "Defeat" })),
    };
  },
};
