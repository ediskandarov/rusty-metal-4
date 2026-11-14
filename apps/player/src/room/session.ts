import type { MatchStatus } from "@tm4/game-runtime/network/match";
import type { RoomAction } from "@tm4/room-player-protocol";

type Join = Extract<RoomAction, { action: "join" }>;
type Operation = { sessionId: string; abort: AbortController };
type SessionState =
  | { phase: "idle" | "disposed" }
  | { phase: "uploading"; operation: Operation; serverStatus?: string }
  | { phase: "uploaded" | "failed"; sessionId: string }
  | { phase: "session"; operation: Operation };

export function createRoomSession({
  join,
  upload,
  show,
}: {
  join: (command: Join, signal: AbortSignal, status: MatchStatus) => Promise<void>;
  upload: (
    sessionId: string,
    signal: AbortSignal,
    progress: (message: string) => void,
  ) => Promise<void>;
  show: MatchStatus;
}) {
  let state: SessionState = { phase: "idle" };

  const replace = (next: SessionState) => {
    const previous = state;
    state = next;
    if ("operation" in previous) previous.operation.abort.abort();
  };
  const failed = (active: SessionState & { operation: Operation }, error: unknown) => {
    if (state !== active) return;
    replace({ phase: "failed", sessionId: active.operation.sessionId });
    show("error", error instanceof Error ? error.message : String(error));
  };

  return {
    handle(command: RoomAction) {
      if (state.phase === "disposed") return;
      switch (command.action) {
        case "status":
          if (state.phase === "uploading") state.serverStatus = command.message;
          else if (state.phase !== "session") show("lobby", command.message);
          break;
        case "stop":
          replace({ phase: "idle" });
          show("lobby", command.message || "Back in the room. Ready when you are.");
          break;
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
            else show(phase, message);
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
            if (state === active) show("lobby", message);
          }).then(
            () => {
              if (state !== active) return;
              state = { phase: "uploaded", sessionId: command.sessionId };
              show(
                "lobby",
                active.serverStatus ?? "Server upload complete. Waiting for validation…",
              );
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
