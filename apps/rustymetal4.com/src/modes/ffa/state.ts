import type { StateCreator } from "zustand/vanilla";

import { roomCarChoices, roomMember, type RoomState } from "../../state/room.ts";

export const initialFfaState = () => ({
  carDraft: undefined as string | undefined,
  sentStatus: null as string | null,
});
export interface FfaSlice {
  ffa: ReturnType<typeof initialFfaState>;
  selectCar(car: string): Promise<void>;
  toggleReady(): Promise<void>;
  ffaStatusSent(status: string | null): void;
}
export function createFfaSlice(
  syncPlayer: (ready?: boolean) => Promise<void>,
): StateCreator<RoomState, [], [], FfaSlice> {
  return (set, get) => ({
    ffa: initialFfaState(),
    async selectCar(car) {
      const state = get();
      if (
        state.room?.modeId !== "ffa" ||
        state.operation ||
        !state.disc ||
        !roomCarChoices(state).includes(car)
      )
        return;
      set({ ffa: { ...state.ffa, carDraft: car } });
      await syncPlayer();
    },
    async toggleReady() {
      if (get().room?.modeId !== "ffa") return;
      await syncPlayer(!roomMember(get())?.ready);
    },
    ffaStatusSent(sentStatus) {
      if (get().ffa.sentStatus !== sentStatus) set({ ffa: { ...get().ffa, sentStatus } });
    },
  });
}
export function ffaSelectedCar(state: RoomState): string | null {
  const cars = roomCarChoices(state);
  const selected = state.ffa.carDraft ?? roomMember(state)?.car;
  return selected && cars.includes(selected) ? selected : (cars[0] ?? null);
}

export function ffaPlayerChoice(state: RoomState) {
  return { car: ffaSelectedCar(state), ready: false };
}
