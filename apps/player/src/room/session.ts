import type { MatchStatus } from "@tm4/game-runtime/network/match";
import type { PlayerEvent, RoomAction } from "@tm4/room-player-protocol";

type Join = Extract<RoomAction, { action: "join" }>;
type Operation = { sessionId: string; abort: AbortController };
type SessionState =
  | { phase: "idle" | "disposed" }
  | { phase: "uploading"; operation: Operation }
  | { phase: "uploaded" | "failed"; sessionId: string }
  | { phase: "session"; operation: Operation };

export function createRoomSession({
  join,
  upload,
  show,
  reportUpload,
}: {
  join: (command: Join, signal: AbortSignal, status: MatchStatus) => Promise<void>;
  upload: (
    sessionId: string,
    signal: AbortSignal,
    progress: (message: string) => void,
  ) => Promise<void>;
  reportUpload: (report: Extract<PlayerEvent, { event: "upload" }>) => void;
  show: (phase: Parameters<MatchStatus>[0], message: string, sessionId: string | null) => void;
}) {
  let state: SessionState = { phase: "idle" };

  const currentSessionId = () =>
    "operation" in state
      ? state.operation.sessionId
      : "sessionId" in state
        ? state.sessionId
        : null;
  const replace = (next: SessionState) => {
    const previous = state;
    state = next;
    if ("operation" in previous) previous.operation.abort.abort();
  };
  const failed = (active: SessionState & { operation: Operation }, error: unknown) => {
    if (state !== active) return;
    replace({ phase: "failed", sessionId: active.operation.sessionId });
    const message = error instanceof Error ? error.message : String(error);
    if (active.phase === "uploading")
      reportUpload({
        event: "upload",
        sessionId: active.operation.sessionId,
        phase: "error",
        message,
      });
    else show("error", message, active.operation.sessionId);
  };

  return {
    handle(command: RoomAction) {
      if (state.phase === "disposed") return;
      switch (command.action) {
        case "stop": {
          if (command.sessionId !== currentSessionId()) return;
          const wasPlaying = state.phase === "session";
          replace({ phase: "idle" });
          if (wasPlaying) show("lobby", "Back in the room. Ready when you are.", null);
          break;
        }
        case "join": {
          if (state.phase === "session" && state.operation.sessionId === command.sessionId) return;
          const active: SessionState & { phase: "session" } = {
            phase: "session",
            operation: { sessionId: command.sessionId, abort: new AbortController() },
          };
          replace(active);
          // match.ts owns connecting, playing and recovery. This layer owns only its lifetime.
          void join(command, active.operation.abort.signal, (phase, message) => {
            if (state !== active) return;
            if (phase === "error") failed(active, message);
            else show(phase, message, command.sessionId);
          }).catch((error: unknown) => failed(active, error));
          break;
        }
        case "upload": {
          if (state.phase === "session" && state.operation.sessionId === command.sessionId) return;
          if (state.phase === "uploading" && state.operation.sessionId === command.sessionId)
            return;
          const active: SessionState & { phase: "uploading" } = {
            phase: "uploading",
            operation: { sessionId: command.sessionId, abort: new AbortController() },
          };
          replace(active);
          void upload(command.sessionId, active.operation.abort.signal, (message) => {
            if (state === active)
              reportUpload({
                event: "upload",
                sessionId: command.sessionId,
                phase: "progress",
                message,
              });
          }).then(
            () => {
              if (state !== active) return;
              state = { phase: "uploaded", sessionId: command.sessionId };
              reportUpload({
                event: "upload",
                sessionId: command.sessionId,
                phase: "complete",
                message: "",
              });
            },
            (error: unknown) => failed(active, error),
          );
          break;
        }
      }
    },
    dispose() {
      replace({ phase: "disposed" });
    },
  };
}
