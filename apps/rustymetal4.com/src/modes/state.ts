import { createFfaSlice, ffaPlayerChoice, initialFfaState } from "./ffa/state.ts";
import {
  createTournamentSlice,
  initialTournamentState,
  tournamentPlayerChoice,
} from "./tournament/state.ts";
export { createFfaSlice, createTournamentSlice };
export const initialModeState = () => ({
  ffa: initialFfaState(),
  tournament: initialTournamentState(),
});
export const modePlayerChoice = { ffa: ffaPlayerChoice, tournament: tournamentPlayerChoice };
