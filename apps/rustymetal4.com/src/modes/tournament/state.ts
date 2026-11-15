import type { StateCreator } from "zustand/vanilla";

import { roomCarChoices, roomMember, type RoomState } from "../../state/room.ts";

export const initialTournamentState = () => ({
  choice: null as { car: string | null } | null,
  selectionId: null as string | null,
  sentStatus: null as string | null,
});
export interface TournamentSlice {
  tournament: ReturnType<typeof initialTournamentState>;
  engineCarSelected(requestId: string, car: string | null): Promise<void>;
  openTournamentSelection(): string | null;
  closeTournamentSelection(): void;
  tournamentStatusSent(status: string): void;
}
export function tournamentChoosing(state: RoomState): boolean {
  return (
    state.room?.modeId === "tournament" &&
    !!roomMember(state) &&
    !state.room.closed &&
    !state.departed &&
    state.connection !== "expired" &&
    !!state.disc &&
    !["starting", "connecting", "playing", "stopping", "finished"].includes(
      state.room.match?.stage ?? "",
    )
  );
}
export function createTournamentSlice(
  syncPlayer: () => Promise<void>,
): StateCreator<RoomState, [], [], TournamentSlice> {
  return (set, get) => ({
    tournament: initialTournamentState(),
    async engineCarSelected(requestId, car) {
      const state = get();
      if (
        !tournamentChoosing(state) ||
        state.tournament.selectionId !== requestId ||
        (car !== null && !roomCarChoices(state).includes(car))
      )
        return;
      set({ tournament: { ...state.tournament, choice: { car } }, playerNeedsSync: true });
      await syncPlayer();
    },
    openTournamentSelection() {
      if (!tournamentChoosing(get())) return null;
      const current = get().tournament;
      if (current.selectionId) return current.selectionId;
      const selectionId = crypto.randomUUID();
      set({ tournament: { ...current, selectionId, sentStatus: null } });
      return selectionId;
    },
    closeTournamentSelection() {
      const current = get().tournament;
      if (current.selectionId || current.sentStatus)
        set({ tournament: { ...current, selectionId: null, sentStatus: null } });
    },
    tournamentStatusSent(sentStatus) {
      if (get().tournament.sentStatus !== sentStatus)
        set({ tournament: { ...get().tournament, sentStatus } });
    },
  });
}
export function tournamentSelectedCar(state: RoomState): string | null {
  if (state.tournament.choice) return state.tournament.choice.car;
  const selected = roomMember(state)?.car;
  return selected && roomCarChoices(state).includes(selected) ? selected : null;
}

export function tournamentPlayerChoice(state: RoomState) {
  return { car: tournamentSelectedCar(state), ready: !!state.tournament.choice?.car };
}
