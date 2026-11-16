import type { RoomState } from "../../state/room.ts";
import { tournamentSelectionStatus } from "./status.ts";

export function tournamentControls(state: RoomState) {
  const room = state.room;
  if (room?.modeId !== "tournament") return null;
  return {
    selectionStatus: state.tournament.selectionId ? tournamentSelectionStatus(state) : null,
  };
}
