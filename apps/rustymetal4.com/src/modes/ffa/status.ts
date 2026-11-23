import type { CarSelectionStatus } from "@tm4/room-player-protocol";

import { roomMember, type RoomState } from "../../state/room.ts";
import { pendingSelectionStatus } from "../car-selection/status.ts";
export function ffaSelectionStatus(state: RoomState): CarSelectionStatus {
  const pending = pendingSelectionStatus(state);
  if (pending) return pending;
  const self = roomMember(state)!;
  if (state.room?.match?.stage === "playing")
    return {
      phase: "confirming",
      title: "Joining the match…",
      message: "Waiting for the server to admit your car.",
    };
  const others = state.room!.participants.filter(
    (member) => member.id !== self.id && (!member.ready || !member.connected),
  );
  return {
    phase: others.length ? "waiting" : "ready",
    title: `${self.car} confirmed`,
    message:
      (others.length
        ? "Waiting for the other players to confirm their cars. "
        : "The host can start after preparing the server. ") + "Use Back to change your choice.",
  };
}
