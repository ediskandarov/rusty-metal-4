import { createCarSelectionControls } from "../car-selection/controls.ts";
import type { RoomMode } from "../types.ts";
import { ffaSettings } from "./settings.ts";
import { ffaSelectionStatus } from "./status.ts";
export const ffa: RoomMode = {
  settings: ffaSettings,
  createControls(store, send) {
    return createCarSelectionControls(
      store,
      send,
      ffaSelectionStatus,
      "Each player loads their own disc, chooses a car in the game and presses Done. Back cancels the choice. The host prepares the server and starts with at least one confirmed human player. During a match, Done joins with the chosen car. Bots keep their reserved places.",
    );
  },
  results(result) {
    const winners = result.participants.filter((row) => row.winner);
    const reason =
      result.completion.reasons === 3
        ? "Time and frag limits reached"
        : result.completion.reasons === 2
          ? "Frag limit reached"
          : "Time limit reached";
    return {
      summary:
        reason +
        " · " +
        (winners.length > 1
          ? "Tied winners: "
          : winners.length
            ? "Winner: "
            : "No remaining participants") +
        winners.map((row) => row.name).join(", "),
      rows: [...result.participants]
        .sort((a, b) => b.score.frags - a.score.frags || a.identity.slot - b.identity.slot)
        .map((participant) => ({
          participant,
          outcome: participant.winner ? (winners.length > 1 ? "Tied winner" : "Winner") : "",
        })),
    };
  },
};
