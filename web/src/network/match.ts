import type { Frame, Input, NetworkEngine, NetworkPort, RoundState, Start } from "./protocol.ts";
import { configureMatch, enqueueStep, stateSections } from "./protocol.ts";
import type { ReplayBegin, ReplayChunk } from "./replay.ts";
import { ReplayJournal } from "./replay.ts";
import { connectNetwork } from "./transport.ts";

type Message =
  | Start
  | Frame
  | ReplayBegin
  | ReplayChunk
  | { type: "recovery_end"; tick: number; state: RoundState }
  | { type: "input_ack"; sequence: number; tick: number | null; rejected: string | null }
  | { type: "welcome"; slot: number }
  | { type: "error"; message: string };

const journalIdleMs = 7_000;

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

export async function joinMatch(engine: NetworkEngine, endpoint: string, status: HTMLElement) {
  const { tm4Port: port } = globalThis as typeof globalThis & { tm4Port: NetworkPort };
  status.textContent = "Preparing network session…";

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
  const diagnostics: NonNullable<NetworkPort["netDiagnostics"]> = (port.netDiagnostics = {
    pendingInputs: 0,
    rejectedInputs: 0,
    processedSequence: 0,
    receivedFrames: 0,
    transport: socket.diagnostics(),
  });

  const send = (message: object) => socket.send(message);
  const cleanup = (message: string, cancel: boolean) => {
    if (closed) return;
    closed = true;
    delete port.netMatchTick;
    delete port.netMatchInput;
    pending.length = 0;
    history.clear();
    clearTimeout(recoveryDeadline);
    recovery?.abort.abort();
    recovery = undefined;
    diagnostics.pendingInputs = 0;
    if (cancel) queueMicrotask(() => engine._WebNetCancelMatch());
    status.textContent = message;
    socket.close();
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    cleanup(message, true);
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
      status.textContent = state.acceptsContinue ? result + " · Press Cross to continue" : result;
    }
    if (state.nextMode) {
      const result = state.winner < 0 ? "Draw" : state.winner === slot ? "You won" : "You lost";
      cleanup("Match finished · " + result, true);
    }
  };

  status.textContent = "Connecting to Deathmatch…";
  socket.onopen = () => send({ type: "join", compatibility: port.compatibility });
  socket.onerror = (error) => fail(error);

  port.netMatchInput = (buttons, axes, analog) => {
    if (closed || recovery || socket.readyState !== WebSocket.OPEN) return;
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
      status.textContent = "Restoring the match…";
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

  socket.onmessage = (data: unknown) => {
    if (closed) return;
    try {
      const message = data as Message;
      switch (message.type) {
        case "welcome":
          if (!Number.isInteger(message.slot) || message.slot < 0 || message.slot >= 8)
            throw new Error("Invalid player slot");
          slot = message.slot;
          status.textContent = "Player " + (slot + 1) + " · Waiting for the other players";
          break;
        case "start": {
          if (players || slot < 0 || !configureMatch(engine, message, slot))
            throw new Error(port.netSession?.message ?? "The game refused the match setup");
          players = message.players;
          epoch = message.epoch;
          status.textContent = "Loading Deathmatch…";
          if (!port.netMatch) throw new Error("The game did not become ready at tick zero");
          if (closed) return;
          initialDigest = port.netMatch.digest ?? 0;
          initialRecoverable = port.netMatch.unsupported === null;
          send({ type: "ready", epoch, digest: initialDigest });
          status.textContent = "Player " + (slot + 1) + " of " + players;
          break;
        }
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
          status.textContent = "Player " + (slot + 1) + " of " + players;
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
          if (recovery) break;
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
