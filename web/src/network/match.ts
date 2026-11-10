import { attachLivePrediction } from "./livePrediction.ts";
import type { Frame, Input, NetworkEngine, NetworkPort, RoundState, Start } from "./protocol.ts";
import { configureMatch, enqueueStep, stateSections } from "./protocol.ts";
import type { ReplayBegin, ReplayChunk } from "./replay.ts";
import { checksum, ReplayJournal, replaySchema } from "./replay.ts";
import { connectNetwork } from "./transport.ts";

type Message =
  | Start
  | (Omit<Start, "type"> & { type: "prediction_prepare" | "resume_prepare" })
  | { type: "resume_credential"; token: string }
  | SnapshotBegin
  | { type: "snapshot_chunk"; attempt: number; offset: number; data: number[] }
  | { type: "resume_journal"; attempt: number; start: number; head: number; digest: number }
  | { type: "resume_live"; attempt: number; anchor: number; head: number; sequence: number }
  | { type: "resume_active"; head: number }
  | { type: "prediction_offer" | "prediction_begin"; anchor: number }
  | Frame
  | ReplayBegin
  | ReplayChunk
  | { type: "recovery_end"; tick: number; state: RoundState }
  | { type: "input_ack"; sequence: number; tick: number | null; rejected: string | null }
  | { type: "welcome"; slot: number }
  | { type: "error"; message: string };

const journalIdleMs = 7_000;
const maxSnapshotBytes = 256 * 1024;
const snapshotChunkBytes = 8192;
const maxResumeTicks = 240;

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
  journal?: ReplayJournal;
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

export function setMatchStatus(
  status: HTMLElement,
  state: "lobby" | "playing" | "error",
  message: string,
) {
  if (status.dataset.matchState !== state) status.dataset.matchState = state;
  if (status.textContent !== message) status.textContent = message;
}

export async function joinMatch(engine: NetworkEngine, endpoint: string, status: HTMLElement) {
  const { tm4Port: port } = globalThis as typeof globalThis & { tm4Port: NetworkPort };
  const show = (state: "lobby" | "playing" | "error", message: string) =>
    setMatchStatus(status, state, message);
  show("lobby", "Connecting to Deathmatch…");

  const socket = await connectNetwork(endpoint);
  const pending: Frame[] = [];
  let running: Frame | undefined;
  let slot = -1;
  let players = 0;
  let sequence = 0;
  let nextFrame = 0;
  let closed = false;
  let lastInput: Input | undefined;
  let lastSent = 0;
  let epoch = 0;
  const history = new Map<number, Input>();
  let initialDigest = 0;
  let initialRecoverable = false;
  let recovery: Recovery | undefined;
  let recoveryDeadline: ReturnType<typeof setTimeout> | undefined;
  let recoveryUsed = false;
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
    pendingInputs: 0,
    rejectedInputs: 0,
    processedSequence: 0,
    receivedFrames: 0,
    transport: socket.diagnostics(),
  });

  const send = (message: object) => socket.send(message);
  const cleanup = (message: string, state: "lobby" | "error") => {
    if (closed) return;
    closed = true;
    delete port.netMatchTick;
    delete port.netMatchInput;
    prediction?.close();
    pending.length = 0;
    history.clear();
    clearTimeout(recoveryDeadline);
    recovery?.abort.abort();
    recovery = undefined;
    diagnostics.pendingInputs = 0;
    queueMicrotask(() => engine._WebNetCancelMatch());
    show(state, message);
    socket.close();
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    cleanup(message, "error");
  };
  const runNext = () => {
    if (closed || running || recovery) return;
    running = pending.shift();
    if (running) enqueueStep(engine, running);
  };

  const armJournalTimeout = () => {
    clearTimeout(recoveryDeadline);
    recoveryDeadline = setTimeout(() => fail("Match journal progress timed out"), journalIdleMs);
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
      credential
        ? { type: "resume", token: credential, compatibility: port.compatibility }
        : { type: "join", compatibility: port.compatibility },
    );
  socket.onerror = (error) => {
    try {
      diagnostics.transport = socket.diagnostics();
      console.error("Match clock at disconnect", diagnostics.transport);
    } catch {
      // The last verified frame still has transport diagnostics after a runtime trap.
    } finally {
      fail(error);
    }
  };

  port.netMatchInput = (buttons, axes, analog) => {
    if (closed || recovery || socket.readyState !== WebSocket.OPEN) return;
    if (prediction) {
      try {
        socket.predictionInput(buttons, axes, analog);
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (
      lastInput?.buttons === buttons &&
      lastInput.axes === axes &&
      lastInput.analog === analog &&
      performance.now() - lastSent < 100
    )
      return;
    const input = { buttons, axes, analog };
    if (!epoch) return;
    try {
      // Rust returns the unsent sample it coalesced. Only retained/transmitted
      // commands belong in acknowledgement history, not every render sample.
      const superseded = send({
        type: "input",
        epoch,
        sequence: ++sequence,
        tick: nextFrame + 6,
        input,
      });
      if (superseded !== undefined) history.delete(superseded);
      history.set(sequence, input);
      diagnostics.pendingInputs = history.size;
      if (history.size > 60) {
        fail("Input acknowledgement stalled; controls stopped");
        return;
      }
    } catch (error) {
      fail(error);
      return;
    }
    lastSent = performance.now();
    lastInput = input;
  };
  port.netMatchTick = () => {
    const local = port.netMatch;
    const frame = running;
    if (!local || !frame || local.tick !== frame.tick + 1) return;
    running = undefined;
    const { state } = frame;
    port.netMatchServerState = state;
    if (!sameOutcome(local, state)) {
      diagnostics.divergence = stateSections.filter(
        (_, i) => local.sections?.[i] !== state.sections[i],
      );
      if (!initialRecoverable || recoveryUsed || state.unsupported || state.nextMode) {
        fail("Simulation diverged from the server at tick " + frame.tick);
        return;
      }
      recoveryUsed = true;
      recovery = { abort: new AbortController(), requestedAt: performance.now() };
      pending.length = 0;
      history.clear();
      diagnostics.pendingInputs = 0;
      show("lobby", "Restoring the match…");
      armJournalTimeout();
      send({ type: "recover", epoch, tick: frame.tick });
      return;
    }
    displayOutcome(state);
    queueMicrotask(() => {
      try {
        runNext();
      } catch (error) {
        fail(error);
      }
    });
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
    armJournalTimeout();
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
        case "resume_credential":
          if (!/^[0-9a-f]{64}$/.test(message.token)) throw new Error("Invalid match credential");
          try {
            sessionStorage.setItem(credentialKey, message.token);
          } catch {
            // Playing without session storage is still supported.
          }
          break;
        case "resume_prepare":
        case "prediction_prepare":
        case "start": {
          show("lobby", "Loading Deathmatch…");
          if (message.type === "prediction_prepare" || message.type === "resume_prepare") {
            if (prediction || players || message.world !== "Construction Yard")
              throw new Error("Live rollback requires a stock Construction Yard match");
            prediction = attachLivePrediction(engine, port);
            delete port.netMatchTick;
            socket.preparePrediction(message.players);
          }
          if (players || slot < 0 || !configureMatch(engine, { ...message, type: "start" }, slot))
            throw new Error(port.netSession?.message ?? "The game refused the match setup");
          players = message.players;
          epoch = message.epoch;
          if (!port.netMatch) throw new Error("The game did not become ready at tick zero");
          if (closed) return;
          initialDigest = port.netMatch.digest ?? 0;
          initialRecoverable = port.netMatch.unsupported === null;
          if (prediction && !initialRecoverable)
            throw new Error(
              "Live rollback cannot restore this roster: " + port.netMatch.unsupported,
            );
          if (message.type === "resume_prepare") {
            if (!message.portable || !credential) throw new Error("This match cannot resume");
            resumePending = true;
            recovery = { abort: new AbortController(), requestedAt: performance.now() };
            show("lobby", "Downloading the current match state…");
            armJournalTimeout();
          } else {
            send({ type: "ready", epoch, digest: initialDigest });
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
          armJournalTimeout();
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
          armJournalTimeout();
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
        case "resume_journal":
          if (
            !recovery ||
            recovery.journal ||
            !resume ||
            message.attempt !== resume.header.attempt ||
            message.start !== resume.header.tick ||
            message.head !== resume.target ||
            message.digest !== resume.header.state.digest
          )
            throw new Error("Invalid reconnect catch-up boundary");
          recovery.journal = new ReplayJournal(
            {
              type: "recovery_begin",
              schema: replaySchema,
              epoch,
              head: message.head,
              initial_digest: message.digest,
            },
            epoch,
            players,
            message.digest,
            engine,
            port,
            recovery.abort.signal,
            message.start,
          );
          armJournalTimeout();
          break;
        case "resume_live":
          if (
            !prediction ||
            predictionStarted ||
            !recovery?.journal ||
            !resume ||
            message.attempt !== resume.header.attempt ||
            message.anchor !== resume.header.anchor ||
            message.head !== resume.target ||
            message.head !== port.netMatch?.tick
          )
            throw new Error("Invalid reconnect prediction boundary");
          recovery.journal.finish(message.head);
          socket.beginResumedPrediction(
            message.anchor,
            epoch,
            players,
            slot,
            prediction.depth,
            message.head,
            message.sequence,
          );
          predictionStarted = true;
          nextFrame = message.head;
          port.netConfirmedTick = message.head;
          diagnostics.recoveredTick = message.head;
          diagnostics.replayMs = performance.now() - recovery.requestedAt;
          send({ type: "resume_live_ack", attempt: message.attempt, head: message.head });
          armJournalTimeout();
          break;
        case "resume_active":
          if (!resumePending || !predictionStarted || !resume || message.head !== nextFrame)
            throw new Error("Unexpected reconnect acknowledgement");
          resumePending = false;
          resume = undefined;
          recovery = undefined;
          clearTimeout(recoveryDeadline);
          show("playing", "Player " + (slot + 1) + " of " + players + " · Live prediction");
          break;
        case "recovery_begin":
          if (!recovery || recovery.journal || message.head !== nextFrame)
            throw new Error("Unexpected match journal");
          recovery.journal = new ReplayJournal(
            message,
            epoch,
            players,
            initialDigest,
            engine,
            port,
            recovery.abort.signal,
          );
          armJournalTimeout();
          break;
        case "recovery_frames": {
          const active = recovery;
          if (!active?.journal) throw new Error("Unexpected match journal block");
          const applied = active.journal.accept(message);
          diagnostics.replayBytes = (diagnostics.replayBytes ?? 0) + message.data.length;
          diagnostics.replayChunks = (diagnostics.replayChunks ?? 0) + 1;
          void applied
            .then((tick) => {
              if (active.abort.signal.aborted) return;
              send({ type: "replay_applied", epoch, tick });
              armJournalTimeout();
            })
            .catch((error) => {
              if (!active.abort.signal.aborted) fail(error);
            });
          break;
        }
        case "recovery_end":
          if (!recovery?.journal || !port.netMatch || !sameOutcome(port.netMatch, message.state))
            throw new Error("Match journal did not reach the authority");
          recovery.journal.finish(message.tick);
          diagnostics.replayMs = performance.now() - recovery.requestedAt;
          diagnostics.recoveredTick = message.tick;
          recovery = undefined;
          clearTimeout(recoveryDeadline);
          nextFrame = message.tick;
          port.netMatchServerState = message.state;
          show("playing", "Player " + (slot + 1) + " of " + players);
          displayOutcome(message.state);
          break;
        case "input_ack":
          if (message.rejected) {
            history.delete(message.sequence);
            diagnostics.rejectedInputs++;
            diagnostics.pendingInputs = history.size;
          }
          break;
        case "frame": {
          diagnostics.receivedFrames++;
          if (message.tick % 15 === 0) send({ type: "progress", tick: message.tick });
          diagnostics.transport = socket.diagnostics();
          const acknowledged = message.acknowledged[slot];
          if (acknowledged !== null && acknowledged !== undefined) {
            diagnostics.processedSequence = acknowledged;
            for (const sequence of history.keys())
              if (sequence <= acknowledged) history.delete(sequence);
            diagnostics.pendingInputs = history.size;
          }
          if (message.tick !== nextFrame++ || message.inputs.length !== players)
            throw new Error("Received an out-of-order match frame");
          if (predictionStarted) {
            prediction?.confirm(message.tick + 1);
            port.netConfirmedTick = message.tick + 1;
            port.netMatchServerState = message.state;
            displayOutcome(message.state);
            break;
          }
          if (recovery) break;
          if (message.tick === 0) show("playing", "Player " + (slot + 1) + " of " + players);
          if (pending.length >= 120) throw new Error("Could not keep up with the server");
          pending.push(message);
          runNext();
          break;
        }
        case "error":
          throw new Error(message.message);
      }
    } catch (error) {
      fail(error);
    }
  };
}
