import { attachLivePrediction } from "./livePrediction.ts";
import type { Frame, NetworkEngine, NetworkPort, RoundState, Start } from "./protocol.ts";
import { configureMatch } from "./protocol.ts";
import type { CatchupChunk } from "./replay.ts";
import { checksum, maxResumeTicks, SnapshotReplay } from "./replay.ts";
import { connectNetwork } from "./transport.ts";

export type LobbyState = {
  cars: string[];
  players: { connected: boolean; car: string | null; ready: boolean }[];
};

export type LobbyView = (
  state: (LobbyState & { slot: number; select: (car: string, ready: boolean) => void }) | null,
) => void;

type Message =
  | (LobbyState & { type: "lobby" })
  | (Omit<Start, "type"> & { type: "prediction_prepare" | "resume_prepare" })
  | { type: "resume_credential"; token: string }
  | SnapshotBegin
  | { type: "snapshot_chunk"; attempt: number; offset: number; data: number[] }
  | { type: "resume_catchup"; attempt: number; start: number; head: number; digest: number }
  | { type: "resume_live"; attempt: number; anchor: number; head: number; sequence: number }
  | { type: "resume_active"; head: number }
  | { type: "prediction_offer" | "prediction_begin"; anchor: number }
  | Frame
  | CatchupChunk
  | { type: "welcome"; slot: number }
  | { type: "error"; message: string };

const resumeIdleMs = 7_000;
const maxSnapshotBytes = 256 * 1024;
const snapshotChunkBytes = 8192;

type SnapshotBegin = {
  type: "snapshot_begin";
  attempt: number;
  tick: number;
  anchor: number;
  total: number;
  checksum: number;
  state: RoundState;
};

type SnapshotDownload = {
  header: SnapshotBegin;
  bytes: Uint8Array<ArrayBuffer>;
  received: number;
  target?: number;
};

type Recovery = {
  abort: AbortController;
  requestedAt: number;
  replay?: SnapshotReplay;
  applied?: Promise<void>;
  offered?: boolean;
};

function sameOutcome(local: Partial<RoundState>, remote: RoundState): boolean {
  return (
    local.digest === remote.digest &&
    local.sections?.length === remote.sections.length &&
    remote.sections.every((value, index) => local.sections?.[index] === value) &&
    local.unsupported === remote.unsupported &&
    local.remaining === remote.remaining &&
    local.winner === remote.winner &&
    local.roundFinished === remote.roundFinished &&
    local.acceptsContinue === remote.acceptsContinue &&
    local.nextMode === remote.nextMode &&
    local.scores?.length === remote.scores.length &&
    remote.scores.every(({ wins, losses }, slot) => {
      const score = local.scores?.[slot];
      return score?.wins === wins && score.losses === losses;
    })
  );
}

export type MatchStatus = (state: "lobby" | "playing" | "error", message: string) => void;

export async function joinMatch(
  engine: NetworkEngine,
  endpoint: string,
  show: MatchStatus,
  lobby: LobbyView,
  admission?: string,
) {
  const { tm4Port: port } = globalThis as typeof globalThis & { tm4Port: NetworkPort };
  show("lobby", "Connecting to Deathmatch…");

  const socket = await connectNetwork(endpoint);
  let slot = -1;
  let players = 0;
  let closed = false;
  let epoch = 0;
  let recovery: Recovery | undefined;
  let recoveryDeadline: ReturnType<typeof setTimeout> | undefined;
  let prediction: ReturnType<typeof attachLivePrediction> | undefined;
  let predictionStarted = false;
  let offeredAnchor: number | undefined;
  let resume: SnapshotDownload | undefined;
  let resumePending = false;
  const credentialKey = "tm4.resume." + endpoint;
  let credential: string | null = null;
  try {
    credential = sessionStorage.getItem(credentialKey);
  } catch {
    // Playing without session storage is still supported.
  }
  const diagnostics: NonNullable<NetworkPort["netDiagnostics"]> = (port.netDiagnostics = {
    receivedFrames: 0,
    transport: socket.diagnostics(),
  });

  const send = (message: object) => socket.send(message);
  const cleanup = (message: string, state: "lobby" | "error") => {
    if (closed) return;
    closed = true;
    lobby(null);
    delete port.netMatchInput;
    prediction?.close();
    clearTimeout(recoveryDeadline);
    recovery?.abort.abort();
    recovery = undefined;
    queueMicrotask(() => engine._WebNetCancelMatch());
    show(state, message);
    socket.close();
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    cleanup(message, "error");
  };
  const armResumeTimeout = () => {
    clearTimeout(recoveryDeadline);
    recoveryDeadline = setTimeout(() => fail("Reconnect progress timed out"), resumeIdleMs);
  };

  const displayOutcome = (state: RoundState) => {
    if (state.roundFinished) {
      const result = state.winner < 0 ? "Draw" : state.winner === slot ? "You won" : "You lost";
      show("playing", state.acceptsContinue ? result + " · Press Cross to continue" : result);
    }
    if (state.nextMode) {
      const result = state.winner < 0 ? "Draw" : state.winner === slot ? "You won" : "You lost";
      cleanup("Match finished · " + result, "lobby");
    }
  };

  socket.onopen = () =>
    send(
      (credential ?? admission)
        ? { type: "resume", token: credential ?? admission, compatibility: port.compatibility }
        : { type: "join", compatibility: port.compatibility },
    );
  socket.onerror = (error) => {
    try {
      diagnostics.transport = socket.diagnostics();
      console.error("Match clock at disconnect", diagnostics.transport);
    } catch {
      // The last verified frame still has transport diagnostics after a runtime trap.
    } finally {
      const unsupported = port.netMatch?.unsupported;
      fail(unsupported ? "Live rollback cannot restore this state: " + unsupported : error);
    }
  };

  port.netMatchInput = (buttons, axes, analog) => {
    if (closed || recovery || socket.readyState !== WebSocket.OPEN) return;
    try {
      if (prediction) socket.predictionInput(buttons, axes, analog);
    } catch (error) {
      fail(error);
    }
  };

  const targetResumeClock = async (download: SnapshotDownload, active: Recovery) => {
    while (!socket.predictionIsReady()) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      active.abort.signal.throwIfAborted();
    }
    const { anchor, attempt, tick } = download.header;
    const target = socket.resumeTarget(anchor, tick);
    if (!Number.isInteger(target) || target < tick || target - tick > maxResumeTicks)
      throw new Error("The snapshot fell outside the reconnect window");
    download.target = target;
    send({ type: "resume_clock", attempt, target });
    armResumeTimeout();
  };

  socket.onmessage = (data: unknown) => {
    if (closed) return;
    try {
      const message = data as Message;
      switch (message.type) {
        case "welcome":
          if (!Number.isInteger(message.slot) || message.slot < 0 || message.slot >= 8)
            throw new Error("Invalid player slot");
          slot = message.slot;
          show(
            "lobby",
            "Player " +
              (slot + 1) +
              " · Waiting for the other players\nFor local play, open this match link in another window.",
          );
          break;
        case "lobby":
          if (slot < 0 || slot >= message.players.length || prediction)
            throw new Error("Invalid lobby state");
          show("lobby", "");
          lobby({
            ...message,
            slot,
            select: (car, ready) => {
              if (!closed && !prediction) send({ type: "select_car", car, ready });
            },
          });
          break;
        case "resume_credential":
          if (!/^[0-9a-f]{64}$/.test(message.token)) throw new Error("Invalid match credential");
          try {
            sessionStorage.setItem(credentialKey, message.token);
          } catch {
            // Playing without session storage is still supported.
          }
          break;
        case "resume_prepare":
        case "prediction_prepare": {
          lobby(null);
          show("lobby", "Loading Deathmatch…");
          if (prediction || slot < 0 || slot >= message.players)
            throw new Error("Invalid live prediction setup");
          prediction = attachLivePrediction(engine, port);
          socket.preparePrediction(message.players, message.type === "resume_prepare");
          if (!configureMatch(engine, message, slot))
            throw new Error(port.netSession?.message ?? "The game refused the match setup");
          players = message.players;
          epoch = message.epoch;
          if (!port.netMatch || port.netMatch.digest === undefined)
            throw new Error("The game did not become ready at tick zero");
          if (port.netMatch.unsupported !== null)
            throw new Error(
              "Live rollback cannot restore this roster: " + port.netMatch.unsupported,
            );
          if (message.type === "resume_prepare") {
            if (!message.portable || !credential) throw new Error("This match cannot resume");
            resumePending = true;
            recovery = { abort: new AbortController(), requestedAt: performance.now() };
            show("lobby", "Downloading the current match state…");
            armResumeTimeout();
          } else {
            send({ type: "ready", epoch, digest: port.netMatch.digest });
            show("lobby", "Waiting for all players to finish loading…");
          }
          break;
        }
        case "prediction_offer":
          if (!prediction || predictionStarted || !players)
            throw new Error("Unexpected live prediction clock offer");
          offeredAnchor = message.anchor;
          diagnostics.clockOffers = (diagnostics.clockOffers ?? 0) + 1;
          show("lobby", "Synchronizing match clocks…");
          send({
            type: "prediction_clock",
            epoch,
            anchor: message.anchor,
            tick: socket.predictionClock(),
          });
          break;
        case "prediction_begin":
          if (!prediction || predictionStarted || !players || message.anchor !== offeredAnchor)
            throw new Error("Unexpected live prediction clock anchor");
          socket.beginPrediction(message.anchor, epoch, players, slot, prediction.depth);
          predictionStarted = true;
          show("playing", "Player " + (slot + 1) + " of " + players + " · Live prediction");
          break;
        case "snapshot_begin":
          if (
            !resumePending ||
            !recovery ||
            resume ||
            !Number.isInteger(message.total) ||
            message.total <= 0 ||
            message.total > maxSnapshotBytes ||
            !Number.isInteger(message.tick) ||
            message.tick <= 0 ||
            message.state.unsupported
          )
            throw new Error("Invalid reconnect snapshot header");
          resume = { header: message, bytes: new Uint8Array(message.total), received: 0 };
          diagnostics.snapshotTick = message.tick;
          diagnostics.snapshotBytes = message.total;
          armResumeTimeout();
          break;
        case "snapshot_chunk": {
          const active = recovery;
          const download = resume;
          if (
            !active ||
            !download ||
            download.header.attempt !== message.attempt ||
            message.offset !== download.received ||
            !Array.isArray(message.data) ||
            message.data.length <= 0 ||
            message.data.length > snapshotChunkBytes ||
            download.received + message.data.length > download.bytes.length ||
            !message.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
          )
            throw new Error("Invalid reconnect snapshot block");
          download.bytes.set(message.data, download.received);
          download.received += message.data.length;
          send({ type: "snapshot_received", attempt: message.attempt, offset: download.received });
          armResumeTimeout();
          if (download.received !== download.bytes.length) break;
          if (checksum(download.bytes) !== download.header.checksum)
            throw new Error("Corrupt reconnect snapshot");
          port.portableCheckpoint = download.bytes;
          try {
            if (
              !engine._WebNetBeginPortableReplay?.() ||
              !port.netMatch ||
              port.netMatch.tick !== download.header.tick ||
              !sameOutcome(port.netMatch, download.header.state)
            )
              throw new Error(
                "The game could not restore the snapshot" +
                  (port.portableCheckpointError ? " (" + port.portableCheckpointError + ")" : ""),
              );
          } finally {
            delete port.portableCheckpoint;
          }
          show("lobby", "Catching up with the current match…");
          void targetResumeClock(download, active).catch((error) => {
            if (!active.abort.signal.aborted) fail(error);
          });
          break;
        }
        case "resume_catchup":
          if (
            !recovery ||
            !resume ||
            message.attempt !== resume.header.attempt ||
            message.head !== resume.target ||
            message.start !== (recovery.replay ? port.netMatch?.tick : resume.header.tick) ||
            message.digest !==
              (recovery.replay ? port.netMatch?.digest : resume.header.state.digest)
          )
            throw new Error("Invalid reconnect catch-up boundary");
          if (recovery.replay) recovery.replay.extend(message.start, message.head, message.digest);
          else {
            recovery.replay = new SnapshotReplay(
              message.start,
              message.head,
              message.digest,
              players,
              engine,
              port,
              recovery.abort.signal,
            );
          }
          armResumeTimeout();
          break;
        case "resume_live": {
          const active = recovery;
          const replay = active?.replay;
          const controller = prediction;
          if (
            !controller ||
            predictionStarted ||
            !active ||
            !replay ||
            active.offered ||
            !resume ||
            message.attempt !== resume.header.attempt ||
            message.anchor !== resume.header.anchor ||
            message.head !== resume.target
          )
            throw new Error("Invalid reconnect prediction boundary");
          active.offered = true;
          const start = async () => {
            const { anchor, head, sequence, attempt } = message;
            while (((socket.predictionClock() - anchor - head) | 0) < 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
              active.abort.signal.throwIfAborted();
            }
            active.abort.signal.throwIfAborted();
            if (head !== port.netMatch?.tick) throw new Error("Incomplete reconnect replay");
            const depth = (socket.predictionClock() - anchor - head) | 0;
            if (depth > controller.depth) {
              const retargets = diagnostics.resumeRetargets ?? 0;
              if (retargets >= 2)
                throw new Error("Reconnect handoff could not keep up with the native clock");
              diagnostics.resumeRetargets = retargets + 1;
              active.offered = false;
              await targetResumeClock(resume!, active);
              return;
            }
            replay.finish(head);
            socket.beginResumedPrediction(
              anchor,
              epoch,
              players,
              slot,
              controller.depth,
              head,
              sequence,
            );
            predictionStarted = true;
            port.netConfirmedTick = head;
            diagnostics.recoveredTick = head;
            diagnostics.replayMs = performance.now() - active.requestedAt;
            send({ type: "resume_live_ack", attempt, head });
            armResumeTimeout();
          };
          void (active.applied ?? Promise.resolve()).then(start).catch((error) => {
            if (!active.abort.signal.aborted) fail(error);
          });
          break;
        }
        case "resume_active":
          if (!resumePending || !predictionStarted || !resume || message.head !== resume.target)
            throw new Error("Unexpected reconnect acknowledgement");
          resumePending = false;
          resume = undefined;
          recovery = undefined;
          clearTimeout(recoveryDeadline);
          show("playing", "Player " + (slot + 1) + " of " + players + " · Live prediction");
          break;
        case "catchup_frames": {
          const active = recovery;
          if (!active?.replay || !resume || message.attempt !== resume.header.attempt)
            throw new Error("Unexpected reconnect replay block");
          diagnostics.replayBytes = (diagnostics.replayBytes ?? 0) + message.data.length;
          diagnostics.replayChunks = (diagnostics.replayChunks ?? 0) + 1;
          active.applied = active.replay.accept(message).then((tick) => {
            if (active.abort.signal.aborted) return;
            send({ type: "catchup_applied", attempt: message.attempt, tick });
            armResumeTimeout();
          });
          void active.applied.catch((error) => {
            if (!active.abort.signal.aborted) fail(error);
          });
          break;
        }
        case "frame":
          if (!prediction || !predictionStarted || resumePending)
            throw new Error("Unexpected live confirmation before prediction starts");
          diagnostics.receivedFrames++;
          diagnostics.transport = socket.diagnostics();
          if (message.tick % 15 === 0) send({ type: "progress", tick: message.tick });
          prediction.confirm(message.tick + 1);
          port.netConfirmedTick = message.tick + 1;
          port.netMatchServerState = message.state;
          displayOutcome(message.state);
          break;
        case "error":
          throw new Error(message.message);
      }
    } catch (error) {
      fail(error);
    }
  };
  return () => cleanup("Returned to room", "lobby");
}
