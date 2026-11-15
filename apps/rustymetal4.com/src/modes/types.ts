import type { RoomAction } from "@tm4/room-player-protocol";
import type { RoomResult } from "@tm4/rooms-client/schemas";

import type { RoomStore } from "../state/room.ts";
export type RoomState = ReturnType<RoomStore["getState"]>;
export type SendPlayerAction = (action: RoomAction) => void;
export interface ModeControls {
  render(): void;
  reset(): void;
  selected?(requestId: string, car: string | null): void;
}
export interface ResultPresentation {
  summary: string;
  rows: { participant: RoomResult["participants"][number]; outcome: string }[];
}
export interface RoomMode {
  minimumPlayers: number;
  createControls(store: RoomStore, send: SendPlayerAction): ModeControls;
  results(result: RoomResult): ResultPresentation;
}
