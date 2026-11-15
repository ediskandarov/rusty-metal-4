import type { RoomState } from "../../state/room.ts";
import { tournamentSelectionStatus } from "./status.ts";

export function tournamentControls(state: RoomState) {
  const room = state.room;
  if (room?.modeId !== "tournament") return null;
  return {
    matchStatus:
      room.match?.message ||
      room.notice ||
      "Choose and confirm your car in the game below. The host prepares the server before starting the battle.",
    selectionStatus: state.tournament.selectionId ? tournamentSelectionStatus(state) : null,
  };
}
