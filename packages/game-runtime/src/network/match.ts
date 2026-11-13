import type { LobbyState, Message, Request, SnapshotBegin } from "@tm4/lightyear-client/schemas";

import { startClientJournal } from "./journal.ts";
import { attachLivePrediction } from "./livePrediction.ts";
import type { NetworkEngine, NetworkPort, RoundState } from "./protocol.ts";
import { configureMatch } from "./protocol.ts";
import { checksum, maxResumeTicks, SnapshotReplay } from "./replay.ts";
import { connectNetwork } from "./transport.ts";
export type { LobbyState } from "@tm4/lightyear-client/schemas";

export type LobbyView = (
  state: (LobbyState & { slot: number; select: (car: string, ready: boolean) => void }) | null,
) => void;

const resumeIdleMs = 7_000;
const maxSnapshotBytes = 256 * 1024;
const snapshotChunkBytes = 8192;

type SnapshotDownload = {
  header: SnapshotBegin;
  bytes: Uint8Array<ArrayBuffer>;
  received: number;
  target?: number;
};

type Recovery = {
  stage: "downloading" | "catchup" | "handoff" | "activating";
  abort: AbortController;
  requestedAt: number;
  download?: SnapshotDownload;
  replay?: SnapshotReplay;
  applied?: Promise<void>;
};

type SessionState =
  | { phase: "connecting" | "lobby" | "playing" | "suspended" | "reconnecting" | "closed" }
  | { phase: "preparing"; offeredAnchor?: number }
  | { phase: "recovering"; recovery: Recovery };

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

  const journal = startClientJournal();
  const path = new URL(endpoint, location.href).pathname;
  const ids = /\/rooms\/([a-f0-9]{32})\/match\/([a-f0-9-]{36})\//.exec(path);
  journal.identify({
    roomId: ids?.[1] ?? null,
    matchId: ids?.[2] ?? null,
    compatibility: port.compatibility,
    browser: navigator.userAgent,
  });
  let socket: Awaited<ReturnType<typeof connectNetwork>>;
  try {
    socket = await connectNetwork(endpoint);
  } catch (error) {
    journal.freeze(String(error), null);
    throw error;
  }
  let slot = -1;
  let players = 0;
  let epoch = 0;
  let session: SessionState = { phase: "connecting" };
  let recoveryDeadline: ReturnType<typeof setTimeout> | undefined;
  let prediction: ReturnType<typeof attachLivePrediction> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
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

  const send = (message: Request) => socket.send(message);
  const stopAttempt = (phase: "closed" | "suspended") => {
    const previous = session;
    session = { phase };
    socket.close();
    prediction?.close();
    prediction = undefined;
    clearTimeout(recoveryDeadline);
    if (previous.phase === "recovering") previous.recovery.abort.abort();
    players = 0;
    epoch = 0;
    slot = -1;
    // Teardown must happen after the current C/wasm callback has returned.
    queueMicrotask(() => engine._WebNetCancelMatch());
  };
  const cleanup = (message: string, state: "lobby" | "error") => {
    if (session.phase === "closed") return;
    journal.freeze(message, diagnostics);
    clearTimeout(reconnectTimer);
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("pagehide", pageHidden);
    window.removeEventListener("pageshow", pageShown);
    lobby(null);
    delete port.netMatchInput;
    stopAttempt("closed");
    show(state, message);
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    cleanup(message, "error");
  };
  const armResumeTimeout = () => {
    clearTimeout(recoveryDeadline);
    recoveryDeadline = setTimeout(() => fail("Reconnect progress timed out"), resumeIdleMs);
  };

  const reconnect = async () => {
    if (session.phase !== "suspended" || document.hidden) return;
    const attempt: SessionState = { phase: "reconnecting" };
    session = attempt;
    show("lobby", "Reconnecting to the current match…");
    try {
      const next = await connectNetwork(endpoint);
      if (session !== attempt || document.hidden) {
        next.close();
        if (session === attempt) session = { phase: "suspended" };
        return;
      }
      socket = next;
      session = { phase: "connecting" };
      bindSocket();
    } catch (error) {
      if (session === attempt) fail(error);
    } finally {
      if (session.phase === "suspended" && !document.hidden) scheduleReconnect();
    }
  };
  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    // Let the old transport close on the server before reclaiming its slot.
    reconnectTimer = setTimeout(() => void reconnect(), 500);
  };
  const suspend = (reason: string) => {
    if (session.phase === "closed" || !credential) return false;
    if (session.phase !== "suspended") {
      journal.record("suspend", port.netMatch?.tick ?? null, { reason });
      stopAttempt("suspended");
      lobby(null);
      show("lobby", "Game paused in this tab. The match continues on the server.");
    }
    clearTimeout(reconnectTimer);
    if (!document.hidden) scheduleReconnect();
    return true;
  };
  const visibilityChanged = () => {
    if (document.hidden) suspend("hidden");
    else if (session.phase === "suspended") scheduleReconnect();
  };
  const pageHidden = () => suspend("pagehide");
  const pageShown = () => {
    if (session.phase === "suspended" && !document.hidden) scheduleReconnect();
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

  const onopen = () => {
    const token = credential ?? admission;
    if (!port.compatibility) throw new Error("Local resource compatibility is unavailable");
    send(
      token
        ? { type: "resume", token, compatibility: port.compatibility }
        : { type: "join", compatibility: port.compatibility },
    );
  };
  const onerror = (error: unknown) => {
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
    if (
      (session.phase !== "preparing" && session.phase !== "playing") ||
      socket.readyState !== WebSocket.OPEN
    )
      return;
    try {
      journal.record("controls", port.netMatch?.tick ?? null, { buttons, axes, analog });
      socket.predictionInput(buttons, axes, analog);
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

  const onmessage = (message: Message) => {
    if (session.phase === "closed") return;
    try {
      switch (message.type) {
        case "prediction_recovery_required":
          diagnostics.transport = socket.diagnostics();
          journal.record("recovery-required", port.netMatch?.tick ?? null, {
            ...message,
            transport: diagnostics.transport,
          });
          if (port.netMatch?.unsupported || !suspend(message.message))
            throw new Error(port.netMatch?.unsupported ?? message.message);
          break;
        case "welcome":
          if (!Number.isInteger(message.slot) || message.slot < 0 || message.slot >= 8)
            throw new Error("Invalid player slot");
          slot = message.slot;
          session = { phase: "lobby" };
          journal.identify({ slot });
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
              if (session.phase === "lobby") send({ type: "select_car", car, ready });
            },
          });
          break;
        case "resume_credential":
          if (!/^[0-9a-f]{64}$/.test(message.token)) throw new Error("Invalid match credential");
          credential = message.token;
          try {
            sessionStorage.setItem(credentialKey, message.token);
          } catch {
            // Playing without session storage is still supported.
          }
          if (document.hidden) suspend("hidden");
          break;
        case "resume_prepare":
        case "prediction_prepare": {
          lobby(null);
          show("lobby", "Loading Deathmatch…");
          if (prediction || slot < 0 || slot >= message.players)
            throw new Error("Invalid live prediction setup");
          journal.identify({
            world: message.world,
            cars: message.cars,
            seed: message.seed,
            players: message.players,
            epoch: message.epoch,
            compatibility: message.compatibility,
          });
          prediction = attachLivePrediction(engine, port, journal);
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
            diagnostics.resumeRetargets = 0;
            session = {
              phase: "recovering",
              recovery: {
                stage: "downloading",
                abort: new AbortController(),
                requestedAt: performance.now(),
              },
            };
            show("lobby", "Downloading the current match state…");
            armResumeTimeout();
          } else {
            session = { phase: "preparing" };
            send({ type: "ready", epoch, digest: port.netMatch.digest });
            show("lobby", "Waiting for all players to finish loading…");
          }
          break;
        }
        case "prediction_offer":
          if (!prediction || session.phase !== "preparing" || !players)
            throw new Error("Unexpected live prediction clock offer");
          session.offeredAnchor = message.anchor;
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
          if (
            !prediction ||
            session.phase !== "preparing" ||
            !players ||
            message.anchor !== session.offeredAnchor
          )
            throw new Error("Unexpected live prediction clock anchor");
          socket.beginPrediction(message.anchor, epoch, players, slot, prediction.depth);
          session = { phase: "playing" };
          show("playing", "Player " + (slot + 1) + " of " + players + " · Live prediction");
          break;
        case "snapshot_begin": {
          const active = session.phase === "recovering" ? session.recovery : undefined;
          if (
            !active ||
            active.stage !== "downloading" ||
            active.download ||
            !Number.isInteger(message.total) ||
            message.total <= 0 ||
            message.total > maxSnapshotBytes ||
            !Number.isInteger(message.tick) ||
            message.tick <= 0 ||
            message.state.unsupported
          )
            throw new Error("Invalid reconnect snapshot header");
          active.download = { header: message, bytes: new Uint8Array(message.total), received: 0 };
          diagnostics.snapshotTick = message.tick;
          diagnostics.snapshotBytes = message.total;
          armResumeTimeout();
          break;
        }
        case "snapshot_chunk": {
          const active = session.phase === "recovering" ? session.recovery : undefined;
          const download = active?.download;
          if (
            !active ||
            active.stage !== "downloading" ||
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
          active.stage = "catchup";
          show("lobby", "Catching up with the current match…");
          void targetResumeClock(download, active).catch((error) => {
            if (!active.abort.signal.aborted) fail(error);
          });
          break;
        }
        case "resume_catchup": {
          const active = session.phase === "recovering" ? session.recovery : undefined;
          const download = active?.download;
          if (
            !active ||
            active.stage !== "catchup" ||
            !download ||
            message.attempt !== download.header.attempt ||
            message.head !== download.target ||
            message.start !== (active.replay ? port.netMatch?.tick : download.header.tick) ||
            message.digest !==
              (active.replay ? port.netMatch?.digest : download.header.state.digest)
          )
            throw new Error("Invalid reconnect catch-up boundary");
          if (active.replay) active.replay.extend(message.start, message.head, message.digest);
          else {
            active.replay = new SnapshotReplay(
              message.start,
              message.head,
              message.digest,
              players,
              engine,
              port,
              active.abort.signal,
            );
          }
          armResumeTimeout();
          break;
        }
        case "resume_live": {
          const active = session.phase === "recovering" ? session.recovery : undefined;
          const replay = active?.replay;
          const download = active?.download;
          const controller = prediction;
          if (
            !controller ||
            !active ||
            !replay ||
            active.stage !== "catchup" ||
            !download ||
            message.attempt !== download.header.attempt ||
            message.anchor !== download.header.anchor ||
            message.head !== download.target
          )
            throw new Error("Invalid reconnect prediction boundary");
          active.stage = "handoff";
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
              active.stage = "catchup";
              await targetResumeClock(download, active);
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
            active.stage = "activating";
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
          if (
            session.phase !== "recovering" ||
            session.recovery.stage !== "activating" ||
            message.head !== session.recovery.download?.target
          )
            throw new Error("Unexpected reconnect acknowledgement");
          session = { phase: "playing" };
          clearTimeout(recoveryDeadline);
          journal.record("resumed", message.head, { snapshotTick: diagnostics.snapshotTick });
          show("playing", "Player " + (slot + 1) + " of " + players + " · Live prediction");
          break;
        case "catchup_frames": {
          const active = session.phase === "recovering" ? session.recovery : undefined;
          if (
            !active?.replay ||
            active.stage !== "catchup" ||
            message.attempt !== active.download?.header.attempt
          )
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
          if (!prediction || session.phase !== "playing")
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
  const bindSocket = () => {
    const active = socket;
    const current = () =>
      session.phase !== "closed" &&
      session.phase !== "suspended" &&
      session.phase !== "reconnecting" &&
      active === socket;
    active.onopen = () => {
      if (current()) onopen();
    };
    active.onerror = (error) => {
      if (current()) onerror(error);
    };
    active.onmessage = (message) => {
      if (current()) onmessage(message);
    };
    active.beforeUpdate = (gapMs) => {
      if (!current()) return false;
      if (document.hidden && suspend("hidden")) return false;
      const predicting =
        session.phase === "playing" ||
        (session.phase === "recovering" && session.recovery.stage === "activating");
      if (predicting && prediction && gapMs >= (prediction.depth * 1000) / 30 / 2) {
        if (suspend("event-loop gap: " + Math.round(gapMs) + " ms")) return false;
      }
      return true;
    };
  };
  bindSocket();
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pagehide", pageHidden);
  window.addEventListener("pageshow", pageShown);
  if (document.hidden) suspend("hidden");
  return () => cleanup("Returned to room", "lobby");
}
