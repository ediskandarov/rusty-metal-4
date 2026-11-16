import { modeRules } from "../modes/rules.ts";
import type { RoomState } from "./room.ts";

export function matchPreparationControls(state: RoomState) {
  const { room, disc, operation } = state;
  if (!room) return null;
  const match = room.match;
  const host = room.you !== null && room.you === room.hostId && !room.closed && !state.departed;
  const busy = operation !== null;
  const locked = !!match && ["starting", "connecting", "playing", "stopping"].includes(match.stage);
  return {
    prepare: {
      hidden: !host || (!!match && match.stage !== "uploading"),
      disabled: busy || !disc,
      label: match ? "Resume resource upload" : "Prepare server from my disc",
    },
    cancel: { hidden: !host || !match || locked, disabled: busy },
    start: {
      hidden: !host || match?.stage !== "ready",
      disabled:
        busy ||
        room.participants.length < modeRules[room.modeId].minimumPlayers ||
        room.participants.some((member) => !member.ready || !member.connected),
    },
  };
}

export function matchPreparationStatus(state: RoomState): string {
  const match = state.room?.match;
  const report = state.uploadReport;
  if (match?.stage === "uploading" && report?.sessionId === match.id) return report.message;
  return (
    match?.message || state.room?.notice || "Load your disc, then the host can prepare the server."
  );
}
