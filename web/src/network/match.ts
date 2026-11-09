import type { Frame, Input, NetworkEngine, NetworkPort, RoundState, Start } from "./protocol.ts";
import { enqueueStep } from "./protocol.ts";

type Message =
  Start | Frame | { type: "welcome"; slot: number } | { type: "error"; message: string };

function sameOutcome(local: Partial<RoundState>, remote: RoundState): boolean {
  return (
    local.digest === remote.digest &&
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
  status.textContent = "Open the main menu to join the match";
  while (port.screen !== "main" || !port.menuReady) await new Promise(requestAnimationFrame);

  const socket = new WebSocket(endpoint);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const pending: Frame[] = [];
  let running: Frame | undefined;
  let slot = -1;
  let players = 0;
  let sequence = 0;
  let nextFrame = 0;
  let closed = false;
  let lastInput: Input | undefined;
  socket.binaryType = "arraybuffer";

  const send = (message: object) => socket.send(encoder.encode(JSON.stringify(message)));
  const cleanup = (message: string, cancel: boolean) => {
    if (closed) return;
    closed = true;
    delete port.netMatchTick;
    delete port.netMatchInput;
    if (cancel) engine._WebNetCancelMatch();
    status.textContent = message;
    socket.close();
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    cleanup(message, true);
  };
  const runNext = () => {
    if (closed || running) return;
    running = pending.shift();
    if (running) enqueueStep(engine, running);
  };

  status.textContent = "Connecting to Deathmatch…";
  socket.onopen = () => send({ type: "join" });
  socket.onerror = () => fail("Could not connect to the Deathmatch server");
  socket.onclose = () => fail("Disconnected from the Deathmatch server");
  port.netMatchInput = (buttons, axes, analog) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return;
    if (lastInput?.buttons === buttons && lastInput.axes === axes && lastInput.analog === analog)
      return;
    const input = { buttons, axes, analog };
    send({ type: "input", sequence: ++sequence, input });
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
      fail("Simulation diverged from the server at tick " + frame.tick);
      return;
    }
    if (state.roundFinished) {
      const result = state.winner < 0 ? "Draw" : state.winner === slot ? "You won" : "You lost";
      status.textContent = state.acceptsContinue ? result + " · Press Cross to continue" : result;
    }
    if (state.nextMode) {
      const result = state.winner < 0 ? "Draw" : state.winner === slot ? "You won" : "You lost";
      cleanup("Match finished · " + result, false);
      return;
    }
    queueMicrotask(() => {
      try {
        runNext();
      } catch (error) {
        fail(error);
      }
    });
  };

  socket.onmessage = async ({ data }: MessageEvent<ArrayBuffer>) => {
    try {
      const message = JSON.parse(decoder.decode(data)) as Message;
      switch (message.type) {
        case "welcome":
          if (!Number.isInteger(message.slot) || message.slot < 0 || message.slot >= 8)
            throw new Error("Invalid player slot");
          slot = message.slot;
          status.textContent = "Player " + (slot + 1) + " · Waiting for the other players";
          break;
        case "start": {
          if (
            players ||
            slot < 0 ||
            !engine._WebNetRequestMatch(message.players, message.world, message.seed, slot)
          )
            throw new Error("The game refused the match setup");
          players = message.players;
          status.textContent = "Loading Deathmatch…";
          const deadline = performance.now() + 30_000;
          while (!port.netMatch && !closed) {
            if (performance.now() >= deadline) throw new Error("Match loading timed out");
            await new Promise(requestAnimationFrame);
          }
          if (closed) return;
          send({ type: "ready" });
          status.textContent = "Player " + (slot + 1) + " of " + players;
          break;
        }
        case "frame":
          if (message.tick !== nextFrame++ || message.inputs.length !== players)
            throw new Error("Received an out-of-order match frame");
          if (pending.length >= 120) throw new Error("Could not keep up with the server");
          pending.push(message);
          runNext();
          break;
        case "error":
          throw new Error(message.message);
      }
    } catch (error) {
      fail(error);
    }
  };
}
