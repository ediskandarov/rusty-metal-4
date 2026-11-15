import type { TournamentStatus } from "@tm4/room-player-protocol";

import { roomMember } from "../../state/room.ts";
import type { RoomState } from "../types.ts";

export function tournamentSelectionStatus(state: RoomState): TournamentStatus {
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
  const other = state.room?.participants.find((member) => member.id !== self.id);
  const back = "Use Back to change your choice.";
  if (!other)
    return {
      phase: "waiting",
      title: `${self.car} confirmed`,
      message: "Waiting for a second player to join. " + back,
    };
  if (!other.connected)
    return {
      phase: "waiting",
      title: `${self.car} confirmed`,
      message: `Waiting for ${other.name} to reconnect. ` + back,
    };
  if (!other.ready)
    return {
      phase: "waiting",
      title: `${self.car} confirmed`,
      message: `Waiting for ${other.name} to choose a car. ` + back,
    };
  return {
    phase: "ready",
    title: "Both cars confirmed",
    message: "The host can start after preparing the server. " + back,
  };
}
