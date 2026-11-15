import type { RoomState } from "../state/room.ts";
import {
  createFfaSlice,
  ffaPlayerChoice,
  ffaPlayerRequestFinished,
  ffaRoomReceived,
  initialFfaState,
} from "./ffa/state.ts";
import {
  createTournamentSlice,
  initialTournamentState,
  tournamentPlayerChoice,
  tournamentRoomReceived,
} from "./tournament/state.ts";
export { createFfaSlice, createTournamentSlice };
export const initialModeState = () => ({
  ffa: initialFfaState(),
  tournament: initialTournamentState(),
});
export const modePlayerChoice = { ffa: ffaPlayerChoice, tournament: tournamentPlayerChoice };

export const modeRoomReceived = (state: RoomState, reset: boolean, republish: boolean) => ({
  ffa: ffaRoomReceived(state, reset, republish),
  tournament: tournamentRoomReceived(state, reset),
});
export const modePlayerRequestFinished = (state: RoomState) => ({
  ffa: ffaPlayerRequestFinished(state),
});
