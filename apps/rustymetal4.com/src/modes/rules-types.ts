import type { Compatibility, RoomSettings } from "@tm4/rooms-client/schemas";

import type { Member, RoomState } from "../room-state.ts";
export interface PlayerChoice {
  car: string | null;
  compatibility: Compatibility | null;
  ready: boolean;
}
export interface ModeRules {
  minimumPlayers: number;
  carSelection: "room" | "engine";
  allowLateJoin: boolean;
  playingMessage: string;
  readyMessage: string;
  choiceError(state: RoomState, member: Member, choice: PlayerChoice): string | null;
  choiceInvalidatesReady(state: RoomState, member: Member, choice: PlayerChoice): boolean;
  preparationStarted(state: RoomState): void;
  serverPrepared(state: RoomState): void;
  serverOptions(settings: RoomSettings): {
    mode: RoomSettings["modeId"];
    players: number;
    bots: string[];
    world: string;
    limits?: { timeLimitTicks: number; fragLimit: number };
  };
}
