import { roomCarChoices, roomMember, type RoomState } from "../../state/room.ts";
import { ffaSelectedCar } from "./state.ts";

export function ffaControls(state: RoomState) {
  const { room, disc, operation } = state;
  const self = roomMember(state);
  if (room?.modeId !== "ffa" || !self) return null;
  const match = room.match;
  const joining = match?.stage === "playing" && !match.endpoint;
  const locked =
    !!match && ["starting", "connecting", "playing", "stopping"].includes(match.stage) && !joining;
  return {
    choices: roomCarChoices(state),
    selectedCar: ffaSelectedCar(state),
    carDisabled: operation !== null || !disc || locked,
    readyDisabled:
      operation !== null || !disc || (match?.stage !== "ready" && !joining) || !self.car,
    readyLabel: joining ? "Join match" : self.ready ? "Not ready" : "Ready",
  };
}
