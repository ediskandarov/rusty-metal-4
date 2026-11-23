import type { StateCreator } from "zustand/vanilla";

import { roomCarChoices, roomMember, type RoomState } from "../../state/room.ts";
import { modeRules } from "../rules.ts";

export const initialCarSelection = () => ({
  choice: null as { car: string | null } | null,
  selectionId: null as string | null,
  sentStatus: null as string | null,
});
export interface CarSelectionSlice {
  carSelection: ReturnType<typeof initialCarSelection>;
  engineCarSelected(requestId: string, car: string | null): Promise<void>;
  openCarSelection(): string | null;
  closeCarSelection(): void;
  carSelectionStatusSent(status: string): void;
}
export function carSelectionAvailable(state: RoomState): boolean {
  return (
    !!state.room &&
    !!roomMember(state) &&
    !state.room.closed &&
    !state.departed &&
    state.connection !== "expired" &&
    !!state.disc &&
    !["starting", "connecting", "stopping"].includes(state.room.match?.stage ?? "") &&
    (state.room.match?.stage !== "playing" ||
      (modeRules[state.room.modeId].allowLateJoin && !state.room.match.endpoint))
  );
}
export function createCarSelectionSlice(
  syncPlayer: () => Promise<void>,
): StateCreator<RoomState, [], [], CarSelectionSlice> {
  return (set, get) => ({
    carSelection: initialCarSelection(),
    async engineCarSelected(requestId, car) {
      const state = get();
      if (!carSelectionAvailable(state) || state.carSelection.selectionId !== requestId) return;
      if (car !== null && !roomCarChoices(state).includes(car)) {
        set({
          errors: {
            ...state.errors,
            player:
              "This car is not available in this match. Use Back and choose one of: " +
              roomCarChoices(state).join(", ") +
              ".",
          },
        });
        return;
      }
      set({ carSelection: { ...state.carSelection, choice: { car } }, playerNeedsSync: true });
      await syncPlayer();
    },
    openCarSelection() {
      if (!carSelectionAvailable(get())) return null;
      const current = get().carSelection;
      if (current.selectionId) return current.selectionId;
      const selectionId = crypto.randomUUID();
      set({ carSelection: { ...current, selectionId, sentStatus: null } });
      return selectionId;
    },
    closeCarSelection() {
      const current = get().carSelection;
      if (current.selectionId || current.sentStatus)
        set({ carSelection: { ...current, selectionId: null, sentStatus: null } });
    },
    carSelectionStatusSent(sentStatus) {
      if (get().carSelection.sentStatus !== sentStatus)
        set({ carSelection: { ...get().carSelection, sentStatus } });
    },
  });
}
export function selectedCar(state: RoomState): string | null {
  if (state.carSelection.choice) return state.carSelection.choice.car;
  const selected = roomMember(state)?.car;
  return selected && roomCarChoices(state).includes(selected) ? selected : null;
}

export function playerChoice(state: RoomState) {
  return { car: selectedCar(state), ready: !!state.carSelection.choice?.car };
}
