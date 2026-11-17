import type { CarSelectionStatus } from "@tm4/room-player-protocol";

import { roomMember } from "../../state/room.ts";
import { pendingSelectionStatus } from "../car-selection/status.ts";
import type { RoomState } from "../types.ts";

export function tournamentSelectionStatus(state: RoomState): CarSelectionStatus {
  const pending = pendingSelectionStatus(state);
  if (pending) return pending;
  const self = roomMember(state)!;
  const others = state.room?.participants.filter((member) => member.id !== self.id) ?? [];
  const other = others.find((member) => !member.connected || !member.ready);
  const back = "Use Back to change your choice.";
  if (!others.length)
    return {
      phase: "waiting",
      title: `${self.car} confirmed`,
      message: "Waiting for a second player to join. " + back,
    };
  if (other && !other.connected)
    return {
      phase: "waiting",
      title: `${self.car} confirmed`,
      message: `Waiting for ${other.name} to reconnect. ` + back,
    };
  if (other && !other.ready)
    return {
      phase: "waiting",
      title: `${self.car} confirmed`,
      message: `Waiting for ${other.name} to choose a car. ` + back,
    };
  return {
    phase: "ready",
    title: "All cars confirmed",
    message: "The host can start after preparing the server. " + back,
  };
}
