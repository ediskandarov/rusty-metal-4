import type { CarSelectionStatus } from "@tm4/room-player-protocol";

import { roomMember, type RoomState } from "../../state/room.ts";
export function pendingSelectionStatus(state: RoomState): CarSelectionStatus | null {
  if (state.connection !== "live")
    return {
      phase: "reconnecting",
      title: "Reconnecting to the room…",
      message: "Waiting for the server to confirm the players' readiness.",
    };
  if (state.errors.player)
    return {
      phase: "error",
      title: "Your choice was not confirmed",
      message: state.errors.player + " Press Done to retry, or Back to choose again.",
    };
  if (state.operation === "player" || state.playerNeedsSync)
    return {
      phase: "confirming",
      title: "Confirming your choice…",
      message: "Waiting for the room server.",
    };
  const self = roomMember(state);
  if (!self?.ready)
    return {
      phase: "choosing",
      title: "Choose your car",
      message: "Use the game controls below. Done confirms your choice; Back cancels it.",
    };
  return null;
}
