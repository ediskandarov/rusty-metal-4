import { connectNetwork, NetworkConnectionError } from "@tm4/lightyear-client";
import type { LobbyState, Message, Request } from "@tm4/lightyear-client/schemas";

import { startClientJournal } from "./journal.ts";
import { attachLivePrediction } from "./livePrediction.ts";
import type { NetworkEngine, NetworkPort, RoundState } from "./protocol.ts";
import { configureMatch } from "./protocol.ts";
import { createSnapshotRecovery } from "./recovery.ts";
export type { LobbyState } from "@tm4/lightyear-client/schemas";

export type LobbyView = (
  state: (LobbyState & { slot: number; select: (car: string, ready: boolean) => void }) | null,
) => void;

const resumeIdleMs = 7_000;
const maxReconnectAttempts = 3;

type PreparedMatch = {
  slot: number;
  capacity: number;
  epoch: number;
  prediction: ReturnType<typeof attachLivePrediction>;
};

type SessionState =
  | { phase: "connecting" | "suspended" | "reconnecting" | "closed" }
  | { phase: "lobby"; slot: number }
  | { phase: "preparing"; match: PreparedMatch; offeredAnchor?: number }
  | {
      phase: "recovering";
      match: PreparedMatch;
      recovery: ReturnType<typeof createSnapshotRecovery>;
    }
  | { phase: "playing"; match: PreparedMatch };

export type MatchStatus = (state: "lobby" | "playing" | "error", message: string) => void;

export async function joinMatch(
  engine: NetworkEngine,
  endpoint: string,
  show: MatchStatus,
  lobby: LobbyView,
  admission?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
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
    if (signal?.aborted) {
      socket.close();
      signal.throwIfAborted();
    }
  } catch (error) {
    journal.freeze(String(error), null);
    throw error;
  }
  let session: SessionState = { phase: "connecting" };
  let recoveryDeadline: ReturnType<typeof setTimeout> | undefined;
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
    if (previous.phase === "recovering") previous.recovery.close();
    if ("match" in previous) previous.match.prediction.close();
    clearTimeout(recoveryDeadline);
    clearTimeout(reconnectTimer);
    // Teardown must happen after the current C/wasm callback has returned.
    queueMicrotask(() => engine._WebNetCancelMatch());
  };
  const cleanup = (message: string, state: "lobby" | "error") => {
    if (session.phase === "closed") return;
    signal?.removeEventListener("abort", cancelled);
    journal.freeze(message, diagnostics);
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("pagehide", pageHidden);
    window.removeEventListener("pageshow", pageShown);
    lobby(null);
    delete port.netMatchInput;
    stopAttempt("closed");
    show(state, message);
  };
  const cancelled = () => cleanup("Returned to room", "lobby");
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

  const displayOutcome = (state: RoundState, slot: number) => {
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

  const startPlaying = (match: PreparedMatch) => {
    session = { phase: "playing", match };
    reconnectAttempts = 0;
    clearTimeout(recoveryDeadline);
    show("playing", "Player " + (match.slot + 1) + " · Live prediction");
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
          if (session.phase !== "connecting") throw new Error("Unexpected match welcome");
          session = { phase: "lobby", slot: message.slot };
          journal.identify({ slot: message.slot });
          show(
            "lobby",
            "Player " +
              (message.slot + 1) +
              " · Waiting for the other players\nFor local play, open this match link in another window.",
          );
          break;
        case "lobby": {
          if (session.phase !== "lobby") throw new Error("Unexpected lobby state");
          const active = session;
          if (!message.players.some((player) => player.slot === active.slot))
            throw new Error("Invalid lobby state");
          reconnectAttempts = 0;
          clearTimeout(recoveryDeadline);
          show("lobby", "");
          lobby({
            ...message,
            slot: active.slot,
            select: (car, ready) => {
              if (session === active) send({ type: "select_car", car, ready });
            },
          });
          break;
        }
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
          if (session.phase !== "lobby" || session.slot >= message.capacity)
            throw new Error("Invalid live prediction setup");
          const slot = session.slot;
          journal.identify({
            world: message.world,
            cars: message.cars,
            seed: message.seed,
            capacity: message.capacity,
            slots: message.slots,
            epoch: message.epoch,
            compatibility: message.compatibility,
          });
          const match: PreparedMatch = {
            slot,
            capacity: message.capacity,
            epoch: message.epoch,
            prediction: attachLivePrediction(engine, port, journal),
          };
          session = { phase: "preparing", match };
          socket.preparePrediction(
            message.slots.reduce((mask, slot) => mask | (1 << slot), 0),
            message.participants,
            message.cars,
            message.type === "resume_prepare",
          );
          if (!configureMatch(engine, message, slot))
            throw new Error(port.netSession?.message ?? "The game refused the match setup");
          if (!port.netMatch || port.netMatch.digest === undefined)
            throw new Error("The game did not become ready at tick zero");
          if (port.netMatch.unsupported !== null)
            throw new Error(
              "Live rollback cannot restore this roster: " + port.netMatch.unsupported,
            );
          if (message.type === "resume_prepare") {
            if (!message.portable || !credential) throw new Error("This match cannot resume");
            session = {
              phase: "recovering",
              match,
              recovery: createSnapshotRecovery({
                engine,
                port,
                connection: socket,
                configuration: { ...message, slot, depth: match.prediction.depth },
                diagnostics,
                progress: armResumeTimeout,
                show: (message) => show("lobby", message),
                fail,
              }),
            };
            show("lobby", "Downloading the current match state…");
            armResumeTimeout();
          } else {
            send({ type: "ready", epoch: match.epoch, digest: port.netMatch.digest });
            show("lobby", "Waiting for all players to finish loading…");
          }
          break;
        }
        case "prediction_offer":
          if (session.phase !== "preparing")
            throw new Error("Unexpected live prediction clock offer");
          session.offeredAnchor = message.anchor;
          diagnostics.clockOffers = (diagnostics.clockOffers ?? 0) + 1;
          show("lobby", "Synchronizing match clocks…");
          send({
            type: "prediction_clock",
            epoch: session.match.epoch,
            anchor: message.anchor,
            tick: socket.predictionClock(),
          });
          break;
        case "prediction_begin": {
          if (session.phase !== "preparing" || message.anchor !== session.offeredAnchor)
            throw new Error("Unexpected live prediction clock anchor");
          const match = session.match;
          socket.beginPrediction(
            message.anchor,
            match.epoch,
            match.capacity,
            match.slot,
            match.prediction.depth,
          );
          startPlaying(match);
          break;
        }
        case "membership":
          // Rust owns the scheduled plan and any Lightyear rollback it requires.
          break;
        case "snapshot_begin":
        case "snapshot_chunk":
        case "resume_catchup":
        case "catchup_frames":
        case "resume_live":
        case "resume_active": {
          if (session.phase !== "recovering")
            throw new Error("Unexpected snapshot recovery message");
          const snapshotTick = session.recovery.accept(message);
          if (snapshotTick !== undefined) {
            journal.record("resumed", port.netConfirmedTick ?? null, { snapshotTick });
            startPlaying(session.match);
          }
          break;
        }
        case "frame":
          if (session.phase !== "playing")
            throw new Error("Unexpected live confirmation before prediction starts");
          diagnostics.receivedFrames++;
          sampleTransportDiagnostics();
          if (message.tick % 15 === 0) send({ type: "progress", tick: message.tick });
          session.match.prediction.confirm(message.tick + 1);
          port.netConfirmedTick = message.tick + 1;
          port.netMatchServerState = message.state;
          displayOutcome(message.state, session.match.slot);
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
        (session.phase === "recovering" && session.recovery.predicting);
      if (
        predicting &&
        "match" in session &&
        gapMs >= (session.match.prediction.depth * 1000) / 30 / 2
      ) {
        if (suspend("event-loop gap: " + Math.round(gapMs) + " ms")) return false;
      }
      return true;
    };
  };
  signal?.addEventListener("abort", cancelled, { once: true });
  bindSocket();
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pagehide", pageHidden);
  window.addEventListener("pageshow", pageShown);
  if (document.hidden) suspend("hidden");
  return () => cleanup("Returned to room", "lobby");
}
