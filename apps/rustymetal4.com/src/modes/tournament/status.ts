import type { CarSelectionStatus } from "@tm4/room-player-protocol";

import { roomMember } from "../../state/room.ts";
import { pendingSelectionStatus } from "../car-selection/status.ts";
import type { RoomState } from "../types.ts";

export function tournamentSelectionStatus(state: RoomState): CarSelectionStatus {
  const pending = pendingSelectionStatus(state);
  if (pending) return pending;
  const self = roomMember(state)!;
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
