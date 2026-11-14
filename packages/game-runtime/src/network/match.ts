import { connectNetwork, NetworkConnectionError } from "@tm4/lightyear-client";
import type { LobbyState, Message, Request, SnapshotBegin } from "@tm4/lightyear-client/schemas";

import { startClientJournal } from "./journal.ts";
import { attachLivePrediction } from "./livePrediction.ts";
import type { NetworkEngine, NetworkPort, RoundState } from "./protocol.ts";
import { configureMatch } from "./protocol.ts";
import { checksum, maxResumeTicks, SnapshotReplay } from "./replay.ts";
export type { LobbyState } from "@tm4/lightyear-client/schemas";

export type LobbyView = (
  state: (LobbyState & { slot: number; select: (car: string, ready: boolean) => void }) | null,
) => void;

const resumeIdleMs = 7_000;
const maxReconnectAttempts = 3;

type SnapshotDownload = {
  header: SnapshotBegin;
  bytes: Uint8Array<ArrayBuffer>;
  received: number;
  target?: number;
};

type Recovery = {
  phase: "recovering";
  stage: "downloading" | "catchup" | "handoff" | "activating";
  abort: AbortController;
  requestedAt: number;
  retargets: number;
  download?: SnapshotDownload;
  replay?: SnapshotReplay;
  applied?: Promise<void>;
};

type SessionState =
  | { phase: "connecting" | "lobby" | "playing" | "suspended" | "reconnecting" | "closed" }
  | { phase: "preparing"; offeredAnchor?: number }
  | Recovery;

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
    remote.scores.every(({ frags, deaths }, slot) => {
      const score = local.scores?.[slot];
      return score?.frags === frags && score.deaths === deaths;
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
  show("lobby", "Connecting to Free for all…");

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
  let capacity = 0;
  let slotConfiguration: { capacity: number; slots: number[]; cars: string[] } | undefined;
  let epoch = 0;
  let session: SessionState = { phase: "connecting" };
  let recoveryDeadline: ReturnType<typeof setTimeout> | undefined;
  let prediction: ReturnType<typeof attachLivePrediction> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempts = 0;
  const credentialKey = "tm4.resume." + endpoint + (admission ? "." + admission : "");
  let credential: string | null = admission ?? null;
  try {
    credential = sessionStorage.getItem(credentialKey) ?? credential;
  } catch {
    // Playing without session storage is still supported.
  }
  const diagnostics: NonNullable<NetworkPort["netDiagnostics"]> = (port.netDiagnostics = {
    receivedFrames: 0,
  });
  const sampleTransportDiagnostics = () => {
    try {
      diagnostics.transport = socket.diagnostics();
      delete diagnostics.transportError;
    } catch (error) {
      diagnostics.transportError = error instanceof Error ? error.message : String(error);
    }
  };
  sampleTransportDiagnostics();

  const send = (message: Request) => socket.send(message);
  const stopAttempt = (phase: "closed" | "suspended") => {
    const previous = session;
    session = { phase };
    socket.close();
    prediction?.close();
    prediction = undefined;
    clearTimeout(recoveryDeadline);
    if (previous.phase === "recovering") previous.abort.abort();
    capacity = 0;
    slotConfiguration = undefined;
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
    recoveryDeadline = setTimeout(
      () => onerror(new NetworkConnectionError("Reconnect progress timed out")),
      resumeIdleMs,
    );
  };

  const reconnect = async () => {
    if (session.phase !== "suspended" || document.hidden) return;
    if (reconnectAttempts >= maxReconnectAttempts) {
      fail("Could not reconnect after " + maxReconnectAttempts + " attempts");
      return;
    }
    reconnectAttempts++;
    journal.record("reconnect", null, { attempt: reconnectAttempts });
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
      if (session === attempt) onerror(error);
    } finally {
      if (session.phase === "suspended" && !document.hidden) scheduleReconnect();
    }
  };
  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    // Let the old transport close on the server before reclaiming its slot.
    reconnectTimer = setTimeout(() => void reconnect(), 500 * 2 ** reconnectAttempts);
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
    const respawn = port.netMatch?.respawn;
    if (respawn?.state === 3)
      show("playing", "Respawn failed after three attempts. Leave and rejoin to try again.");
    else if (respawn?.state === 2) {
      const seconds = Math.max(0, Math.ceil((respawn.dueTick - port.netMatch!.tick) / 30));
      show("playing", "Respawning in " + seconds + "s…");
    } else show("playing", "Player " + (slot + 1) + " · Live prediction");
    if (state.nextMode) cleanup("Match finished", "lobby");
  };

  const onopen = () => {
    const token = credential ?? admission;
    if (!port.compatibility) throw new Error("Local resource compatibility is unavailable");
    send(
      token
        ? { type: "resume", token, compatibility: port.compatibility }
        : { type: "join", compatibility: port.compatibility },
    );
    if (reconnectAttempts > 0) armResumeTimeout();
  };
  const onerror = (error: unknown) => {
    sampleTransportDiagnostics();
    const unsupported = port.netMatch?.unsupported;
    if (!unsupported && error instanceof NetworkConnectionError && suspend(error.message)) return;
    fail(unsupported ? "Live rollback cannot restore this state: " + unsupported : error);
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
    try {
      switch (message.type) {
        case "resume_pending":
          if (session.phase !== "connecting" || !credential)
            throw new Error("Unexpected reconnect retry response");
          suspend("Previous connection is still closing");
          break;
        case "prediction_recovery_required":
          sampleTransportDiagnostics();
          journal.record("recovery-required", port.netMatch?.tick ?? null, {
            ...message,
            transport: diagnostics.transport,
            transportError: diagnostics.transportError,
          });
          if (port.netMatch?.unsupported || !suspend(message.message))
            throw new Error(port.netMatch?.unsupported ?? message.message);
          break;
        case "welcome":
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
          if (slot < 0 || !message.players.some((player) => player.slot === slot) || prediction)
            throw new Error("Invalid lobby state");
          reconnectAttempts = 0;
          clearTimeout(recoveryDeadline);
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
          show("lobby", "Loading Free for all…");
          if (prediction || slot < 0 || slot >= message.capacity)
            throw new Error("Invalid live prediction setup");
          journal.identify({
            world: message.world,
            cars: message.cars,
            seed: message.seed,
            capacity: message.capacity,
            slots: message.slots,
            epoch: message.epoch,
            compatibility: message.compatibility,
          });
          prediction = attachLivePrediction(engine, port, journal);
          slotConfiguration = {
            capacity: message.capacity,
            slots: message.slots,
            cars: message.cars,
          };
          socket.preparePrediction(
            message.slots.reduce((mask, slot) => mask | (1 << slot), 0),
            message.participants,
            message.cars,
            message.type === "resume_prepare",
          );
          if (!configureMatch(engine, message, slot))
            throw new Error(port.netSession?.message ?? "The game refused the match setup");
          capacity = message.capacity;
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
              stage: "downloading",
              abort: new AbortController(),
              requestedAt: performance.now(),
              retargets: 0,
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
          if (!prediction || session.phase !== "preparing")
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
            message.anchor !== session.offeredAnchor
          )
            throw new Error("Unexpected live prediction clock anchor");
          socket.beginPrediction(message.anchor, epoch, capacity, slot, prediction.depth);
          session = { phase: "playing" };
          reconnectAttempts = 0;
          clearTimeout(recoveryDeadline);
          show("playing", "Player " + (slot + 1) + " · Live prediction");
          break;
        case "membership":
          // Rust owns the scheduled plan and any Lightyear rollback it requires.
          break;
        case "snapshot_begin": {
          const active = session.phase === "recovering" ? session : undefined;
          if (active?.stage !== "downloading" || active.download || message.state.unsupported)
            throw new Error("Invalid reconnect snapshot header");
          active.download = { header: message, bytes: new Uint8Array(message.total), received: 0 };
          diagnostics.snapshotTick = message.tick;
          diagnostics.snapshotBytes = message.total;
          armResumeTimeout();
          break;
        }
        case "snapshot_chunk": {
          const active = session.phase === "recovering" ? session : undefined;
          const download = active?.download;
          if (
            active?.stage !== "downloading" ||
            !download ||
            download.header.attempt !== message.attempt ||
            message.offset !== download.received ||
            download.received + message.data.length > download.bytes.length
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
              !engine._WebNetBeginPortableReplay() ||
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
          const active = session.phase === "recovering" ? session : undefined;
          const download = active?.download;
          if (
            active?.stage !== "catchup" ||
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
              slotConfiguration!,
              engine,
              port,
              active.abort.signal,
            );
          }
          armResumeTimeout();
          break;
        }
        case "resume_live": {
          const active = session.phase === "recovering" ? session : undefined;
          const replay = active?.replay;
          const download = active?.download;
          const controller = prediction;
          if (
            !controller ||
            active?.stage !== "catchup" ||
            !replay ||
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
              if (active.retargets >= 2)
                throw new Error("Reconnect handoff could not keep up with the native clock");
              diagnostics.resumeRetargets = ++active.retargets;
              active.stage = "catchup";
              await targetResumeClock(download, active);
              return;
            }
            replay.finish(head);
            socket.beginResumedPrediction(
              anchor,
              epoch,
              capacity,
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
            session.stage !== "activating" ||
            message.head !== session.download?.target
          )
            throw new Error("Unexpected reconnect acknowledgement");
          journal.record("resumed", message.head, { snapshotTick: session.download.header.tick });
          session = { phase: "playing" };
          reconnectAttempts = 0;
          clearTimeout(recoveryDeadline);
          show("playing", "Player " + (slot + 1) + " · Live prediction");
          break;
        case "catchup_frames": {
          const active = session.phase === "recovering" ? session : undefined;
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
          sampleTransportDiagnostics();
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
        (session.phase === "recovering" && session.stage === "activating");
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
