import type { RoomAction } from "@tm4/room-player-protocol";
import type { RoomResult, RoomSettings } from "@tm4/rooms-client/schemas";

import type { RoomStore } from "../state/room.ts";
export type RoomState = ReturnType<RoomStore["getState"]>;
export type SendPlayerAction = (action: RoomAction) => void;
export interface ModeControls {
  sync(previous: RoomState): void;
  render(): void;
  reset(previous: RoomState): void;
  selected?(requestId: string, car: string | null): void;
}
export interface ResultPresentation {
  summary: string;
  rows: { participant: RoomResult["participants"][number]; outcome: string }[];
}
export interface ModeSettings {
  render(form: HTMLFormElement, state: RoomState): void;
  read(
    form: HTMLFormElement,
    target: EventTarget | null,
  ): Pick<RoomSettings, "mapId" | "modeOptions">;
}
export interface RoomMode {
  settings: ModeSettings;
  createControls(store: RoomStore, send: SendPlayerAction): ModeControls;
  results(result: RoomResult): ResultPresentation;
}
