import { afterEach, expect, mock, test } from "bun:test";

import { clientJournal } from "@tm4/game-runtime/network/journal";
import type { NetworkPort } from "@tm4/game-runtime/network/protocol";
import { checksum } from "@tm4/game-runtime/network/replay";
import { NetworkConnectionError } from "@tm4/lightyear-client";
import type { Message, Request } from "@tm4/lightyear-client/schemas";

class Connection {
  readyState: number = WebSocket.OPEN;
  sent: Request[] = [];
  onopen = () => {};
  onerror = (_error: unknown) => {};
  onmessage = (_message: Message) => {};
  beforeUpdate = (_gapMs: number) => true;
  diagnostics = () => ({});
  send = (message: Request) => this.sent.push(message);
  close = () => {
    this.readyState = WebSocket.CLOSED;
  };
  preparePrediction = () => {};
  predictionClock = () => 120;
  beginPrediction = () => {};
  predictionIsReady = () => true;
  resumeTarget = (_anchor: number, tick: number) => tick;
  beginResumedPrediction = () => {};
  predictionInput = () => {};
}
let connections: Connection[] = [];
let connectionPending: Promise<void> | undefined;
await mock.module("@tm4/lightyear-client", () => ({
  NetworkConnectionError,
  connectNetwork: async () => {
    const connection = new Connection();
    connections.push(connection);
    if (connectionPending) await connectionPending;
    return connection;
  },
}));
const { joinMatch } = await import("@tm4/game-runtime/network/match");
const saved = new Map<string, PropertyDescriptor | undefined>();
let stop: (() => void) | undefined;
function global(name: string, value: unknown) {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(async () => {
  stop?.();
  stop = undefined;
  await Promise.resolve();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
  globalThis.tm4LivePrediction = undefined;
  connections = [];
  connectionPending = undefined;
});

const compatibility = { protocol: 15, build: "a".repeat(64), content: "b".repeat(64) };
const start = {
  mode: "ffa" as const,
  respawnDelayTicks: 90,
  capacity: 8,
  slots: [0, 1],
  world: "Road Rage",
  participants: ["0000000000000001", "0000000000000002"],
  cars: ["Crusher", "Trash Man"],
  seed: 12345,
  epoch: 1,
  portable: true,
  compatibility,
};
const token = "a".repeat(64);
const state = {
  digest: 42,
  sections: [1, 2, 3, 4, 5] as [number, number, number, number, number],
  unsupported: null,
  remaining: 2,
  winner: -1,
  roundFinished: false,
  acceptsContinue: false,
  nextMode: 0,
  scores: [
    { frags: 0, deaths: 0 },
    { frags: 0, deaths: 0 },
  ],
};
async function setup(diagnostics?: Connection["diagnostics"], signal?: AbortSignal) {
  const page = Object.assign(new EventTarget(), { hidden: false });
  const window = new EventTarget();
  global("document", page);
  global("window", window);
  global("location", new URL("https://game.test/"));
  // Automatic recovery must also work when Safari denies session storage.
  global("sessionStorage", {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage blocked");
    },
  });
  const port: NetworkPort = { compatibility };
  global("tm4Port", port);
  let cancellations = 0;
  let loads = 0;
  const engine = {
    ccall(name: string): number {
      if (name === "WebNetWorldIndex") return 0;
      if (name === "WebNetStartFfa") {
        loads++;
        port.netMatch = { tick: 0, ...state };
        return 1;
      }
      return 0;
    },
    _WebNetCancelMatch() {
      cancellations++;
      delete port.netMatch;
    },
    _WebNetLocalRollbackDepth: () => 12,
    _WebNetSetInput: () => 1,
    _WebNetQueueTick: (_tick: number) => 1,
    _WebNetConfirmPresentationTick: () => 1,
    _WebNetEndReplay() {},
    _WebNetBeginPortableReplay() {
      port.netMatch = { tick: 20, ...state };
      return 1;
    },
  };
  const statuses: [string, string][] = [];
  const joining = joinMatch(
    engine,
    "wss://game.test/match",
    (status, text) => {
      statuses.push([status, text]);
    },
    () => {},
    undefined,
    signal,
  );
  if (diagnostics) connections[0]!.diagnostics = diagnostics;
  stop = await joining;
  const first = connections[0]!;
  first.onopen();
  first.onmessage({ type: "welcome", slot: 0 });
  first.onmessage({ type: "resume_credential", token });
  first.onmessage({ type: "prediction_prepare", ...start });
  first.onmessage({ type: "prediction_offer", anchor: 100 });
  first.onmessage({ type: "prediction_begin", anchor: 100 });
  return { page, window, port, engine, first, statuses, counts: () => ({ cancellations, loads }) };
}
async function nextConnection() {
  await Bun.sleep(550);
  expect(connections).toHaveLength(2);
  const next = connections[1]!;
  next.onopen();
  expect(next.sent[0]).toEqual({ type: "resume", token, compatibility });
  return next;
}
function beginSnapshot(next: Connection) {
  next.onmessage({ type: "welcome", slot: 0 });
  next.onmessage({ type: "resume_prepare", ...start });
  const bytes = new Uint8Array([1, 2, 3]);
  next.onmessage({
    type: "snapshot_begin",
    attempt: 1,
    tick: 20,
    anchor: 100,
    total: bytes.length,
    checksum: checksum(bytes),
    state,
  });
  return () => next.onmessage({ type: "snapshot_chunk", attempt: 1, offset: 0, data: [...bytes] });
}
async function downloadSnapshot(next: Connection, target = 20) {
  beginSnapshot(next)();
  await Promise.resolve();
  expect(next.sent).toContainEqual({ type: "resume_clock", attempt: 1, target });
  next.onmessage({ type: "resume_catchup", attempt: 1, start: 20, head: target, digest: 42 });
}
async function restore(next: Connection) {
  await downloadSnapshot(next);
  next.onmessage({ type: "resume_live", attempt: 1, anchor: 100, head: 20, sequence: 4 });
  await Promise.resolve();
  expect(next.sent).toContainEqual({ type: "resume_live_ack", attempt: 1, head: 20 });
  next.onmessage({ type: "resume_active", head: 20 });
}

test("hidden tab resumes the same slot from a server snapshot without sessionStorage", async () => {
  const { page, first, port, statuses, counts } = await setup();
  page.hidden = true;
  page.dispatchEvent(new Event("visibilitychange"));
  expect(first.readyState).toBe(WebSocket.CLOSED);
  expect(first.beforeUpdate(5000)).toBe(false);
  await Bun.sleep(550);
  expect(connections).toHaveLength(1);
  page.hidden = false;
  page.dispatchEvent(new Event("visibilitychange"));
  const next = await nextConnection();
  await restore(next);
  expect(port.netConfirmedTick).toBe(20);
  expect(counts()).toEqual({ cancellations: 1, loads: 2 });
  expect(statuses.at(-1)?.[0]).toBe("playing");
  expect(clientJournal()?.export().stopped).toBeNull();
  expect(
    clientJournal()
      ?.export()
      .events.map((event) => event.kind),
  ).toContain("resumed");
  // Events already queued by the abandoned transport cannot terminate the restored match.
  first.onerror(new Error("old socket"));
  first.onmessage({ type: "error", message: "old session" });
  expect(next.readyState).toBe(WebSocket.OPEN);
});

test("a long event-loop pause is intercepted before advancing stale prediction", async () => {
  const { first } = await setup();
  expect(first.beforeUpdate(5)).toBe(true);
  expect(first.beforeUpdate(1500)).toBe(false);
  expect(first.readyState).toBe(WebSocket.CLOSED);
  await restore(await nextConnection());
});

for (const reason of ["clock_shift", "history_expired"] as const) {
  test(`Lightyear ${reason} restores the existing match through a server snapshot`, async () => {
    const { first, statuses } = await setup();
    first.onmessage({ type: "prediction_recovery_required", reason, message: reason });
    expect(first.readyState).toBe(WebSocket.CLOSED);
    await restore(await nextConnection());
    expect(statuses.at(-1)?.[0]).toBe("playing");
    expect(
      clientJournal()
        ?.export()
        .events.map((event) => event.kind),
    ).toContain("recovery-required");
    expect(clientJournal()?.export().stopped).toBeNull();
  });
}

test("switching focus between visible windows leaves both players connected", async () => {
  const { window, first } = await setup();
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
  expect(first.beforeUpdate(5)).toBe(true);
  expect(first.readyState).toBe(WebSocket.OPEN);
  expect(connections).toHaveLength(1);
});

test("page cache restore reconnects, but leaving the room cancels pending recovery", async () => {
  const { window, first } = await setup();
  window.dispatchEvent(new Event("pagehide"));
  expect(first.readyState).toBe(WebSocket.CLOSED);
  window.dispatchEvent(new Event("pageshow"));
  stop!();
  window.dispatchEvent(new Event("pageshow"));
  await Bun.sleep(550);
  expect(connections).toHaveLength(1);
});

test("a connection completed after suspension cannot replace the current attempt", async () => {
  const { page, first, statuses } = await setup();
  let release!: () => void;
  connectionPending = new Promise<void>((resolve) => {
    release = resolve;
  });
  first.beforeUpdate(1500);
  await Bun.sleep(550);
  expect(connections).toHaveLength(2);
  page.hidden = true;
  page.dispatchEvent(new Event("visibilitychange"));
  release();
  await Bun.sleep(0);
  expect(connections[1]!.readyState).toBe(WebSocket.CLOSED);
  expect(statuses.at(-1)?.[0]).not.toBe("error");

  connectionPending = undefined;
  page.hidden = false;
  page.dispatchEvent(new Event("visibilitychange"));
  await Bun.sleep(1050);
  expect(connections).toHaveLength(3);
  const next = connections[2]!;
  next.onopen();
  await restore(next);
  expect(statuses.at(-1)?.[0]).toBe("playing");
});

test("suspending during snapshot download discards that attempt and its late blocks", async () => {
  const { page, first, statuses } = await setup();
  first.beforeUpdate(1500);
  const interrupted = await nextConnection();
  interrupted.onmessage({ type: "welcome", slot: 0 });
  interrupted.onmessage({ type: "resume_prepare", ...start });
  const bytes = new Uint8Array([1, 2, 3]);
  interrupted.onmessage({
    type: "snapshot_begin",
    attempt: 1,
    tick: 20,
    anchor: 100,
    total: bytes.length,
    checksum: checksum(bytes),
    state,
  });
  interrupted.onmessage({ type: "snapshot_chunk", attempt: 1, offset: 0, data: [1] });
  page.hidden = true;
  page.dispatchEvent(new Event("visibilitychange"));
  interrupted.onmessage({ type: "snapshot_chunk", attempt: 1, offset: 1, data: [2, 3] });
  expect(interrupted.sent.some((message) => message.type === "resume_clock")).toBe(false);
  page.hidden = false;
  page.dispatchEvent(new Event("visibilitychange"));
  await Bun.sleep(1050);
  expect(connections).toHaveLength(3);
  const next = connections[2]!;
  next.onopen();
  await restore(next);
  expect(statuses.at(-1)?.[0]).toBe("playing");
});

test("real state divergence remains fatal rather than being hidden by resynchronization", async () => {
  const { first, statuses } = await setup();
  first.onmessage({ type: "error", message: "Predicted simulation diverged at confirmed tick 42" });
  expect(statuses.at(-1)?.[0]).toBe("error");
  expect(clientJournal()?.export().stopped).toContain("diverged");
  await Bun.sleep(550);
  expect(connections).toHaveLength(1);
});

const unavailableDiagnostics = () => {
  throw new Error("diagnostics unavailable");
};

test("unavailable diagnostics do not prevent joining or confirming frames", async () => {
  const { first, port, statuses } = await setup(unavailableDiagnostics);
  expect(statuses.at(-1)?.[0]).toBe("playing");
  first.onmessage({ type: "frame", changes: [], tick: 0, inputs: [], state });
  expect(port.netConfirmedTick).toBe(1);
  expect(first.readyState).toBe(WebSocket.OPEN);
  expect(port.netDiagnostics?.transportError).toBe("diagnostics unavailable");
  expect(port.netDiagnostics?.transport).toBeUndefined();

  first.diagnostics = () => ({});
  first.onmessage({ type: "frame", changes: [], tick: 1, inputs: [], state });
  expect(port.netConfirmedTick).toBe(2);
  expect(port.netDiagnostics?.transportError).toBeUndefined();
});

test("diagnostic failures do not block snapshot recovery or replace runtime errors", async () => {
  const { first, port, statuses } = await setup();
  first.diagnostics = unavailableDiagnostics;
  first.onmessage({
    type: "prediction_recovery_required",
    reason: "history_expired",
    message: "history expired",
  });
  const next = await nextConnection();
  next.diagnostics = unavailableDiagnostics;
  await restore(next);
  expect(statuses.at(-1)?.[0]).toBe("playing");
  expect(port.netConfirmedTick).toBe(20);
  next.onerror(new Error("runtime failed"));
  expect(statuses.at(-1)).toEqual(["error", "runtime failed"]);
  expect(clientJournal()?.export().stopped).toBe("runtime failed");
});

test("transport loss restores the same player and successful recovery resets the retry budget", async () => {
  const { first, port, statuses } = await setup();
  first.onerror(new NetworkConnectionError("connection lost"));
  const next = await nextConnection();
  await restore(next);
  expect(port.netConfirmedTick).toBe(20);
  expect(statuses.at(-1)?.[0]).toBe("playing");
  next.onerror(new NetworkConnectionError("connection lost again"));
  await Bun.sleep(550);
  const third = connections[2]!;
  third.onopen();
  await restore(third);
  expect(
    clientJournal()
      ?.export()
      .events.filter((event) => event.kind === "reconnect")
      .map((event) => event.data),
  ).toEqual([{ attempt: 1 }, { attempt: 1 }]);
  expect(statuses.at(-1)?.[0]).toBe("playing");
});

test("connection failures stop after three consecutive reconnect attempts", async () => {
  const { first, statuses } = await setup();
  first.onerror(new NetworkConnectionError("connection lost"));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await Bun.sleep(500 * 2 ** (attempt - 1) + 50);
    expect(connections).toHaveLength(attempt + 1);
    connections[attempt]!.onerror(new NetworkConnectionError("connection timed out"));
  }
  await Bun.sleep(4050);
  expect(connections).toHaveLength(4);
  expect(statuses.at(-1)).toEqual(["error", "Could not reconnect after 3 attempts"]);
  expect(clientJournal()?.export().stopped).toContain("3 attempts");
}, 10000);

test("leaving the room cancels a retry after transport loss", async () => {
  const { first } = await setup();
  first.onerror(new NetworkConnectionError("connection lost"));
  stop!();
  await Bun.sleep(550);
  expect(connections).toHaveLength(1);
});

test("a busy previous connection retries, but a rejected credential remains fatal", async () => {
  const { first, statuses } = await setup();
  first.onerror(new NetworkConnectionError("connection lost"));
  const next = await nextConnection();
  next.onmessage({ type: "resume_pending" });
  expect(next.readyState).toBe(WebSocket.CLOSED);
  await Bun.sleep(1050);
  const third = connections[2]!;
  third.onopen();
  third.onmessage({ type: "error", message: "This participant cannot resume this match." });
  expect(statuses.at(-1)).toEqual(["error", "This participant cannot resume this match."]);
  await Bun.sleep(2100);
  expect(connections).toHaveLength(3);
});

test("unsupported simulation state is fatal even when the transport also fails", async () => {
  const { first, port, statuses } = await setup();
  port.netMatch!.unsupported = "unsupported object";
  first.onerror(new NetworkConnectionError("connection lost"));
  expect(statuses.at(-1)).toEqual([
    "error",
    "Live rollback cannot restore this state: unsupported object",
  ]);
  await Bun.sleep(550);
  expect(connections).toHaveLength(1);
});

test("stalled snapshot download retries through the same recovery path", async () => {
  const { first, statuses } = await setup();
  first.onerror(new NetworkConnectionError("connection lost"));
  const next = await nextConnection();
  next.onmessage({ type: "welcome", slot: 0 });
  next.onmessage({ type: "resume_prepare", ...start });
  await Bun.sleep(8100);
  expect(next.readyState).toBe(WebSocket.CLOSED);
  expect(connections).toHaveLength(3);
  const third = connections[2]!;
  third.onopen();
  await restore(third);
  expect(statuses.at(-1)?.[0]).toBe("playing");
}, 10000);

test("recovery owns its retarget limit independently of diagnostic counters", async () => {
  const { first, port, statuses } = await setup();
  first.beforeUpdate(1500);
  const next = await nextConnection();
  await downloadSnapshot(next);
  next.predictionClock = () => 140;
  const handoff = { type: "resume_live", attempt: 1, anchor: 100, head: 20, sequence: 4 } as const;
  // An inflated diagnostic counter cannot reject the first retarget.
  port.netDiagnostics!.resumeRetargets = 999;
  next.onmessage(handoff);
  await Bun.sleep(0);
  expect(port.netDiagnostics!.resumeRetargets).toBe(1);
  expect(next.readyState).toBe(WebSocket.OPEN);
  // Resetting diagnostics cannot grant additional retargets either.
  port.netDiagnostics!.resumeRetargets = 0;
  next.onmessage(handoff);
  await Bun.sleep(0);
  expect(port.netDiagnostics!.resumeRetargets).toBe(2);
  port.netDiagnostics!.resumeRetargets = 0;
  next.onmessage(handoff);
  await Bun.sleep(0);
  expect(statuses.at(-1)).toEqual([
    "error",
    "Reconnect handoff could not keep up with the native clock",
  ]);
});

test("leaving while waiting for the recovery clock cannot send a late target", async () => {
  const { first, statuses, counts } = await setup();
  first.onerror(new NetworkConnectionError("connection lost"));
  const next = await nextConnection();
  next.predictionIsReady = () => false;
  beginSnapshot(next)();
  stop!();
  next.predictionIsReady = () => true;
  await Bun.sleep(30);
  expect(next.sent.some((message) => message.type === "resume_clock")).toBe(false);
  expect(globalThis.tm4LivePrediction).toBeUndefined();
  expect(counts()).toEqual({ cancellations: 2, loads: 2 });
  expect(statuses.at(-1)).toEqual(["lobby", "Returned to room"]);
});

test("leaving during handoff cannot restart prediction or acknowledge the old attempt", async () => {
  const { first, engine, statuses } = await setup();
  first.onerror(new NetworkConnectionError("connection lost"));
  const next = await nextConnection();
  await downloadSnapshot(next);
  const ends = mock(() => {});
  engine._WebNetEndReplay = ends;
  const begin = mock(() => {});
  next.beginResumedPrediction = begin;
  next.predictionClock = () => 119;
  next.onmessage({ type: "resume_live", attempt: 1, anchor: 100, head: 20, sequence: 4 });
  await Promise.resolve();
  stop!();
  next.predictionClock = () => 120;
  await Bun.sleep(10);
  expect(ends).toHaveBeenCalledTimes(1);
  expect(begin).not.toHaveBeenCalled();
  expect(next.sent.some((message) => message.type === "resume_live_ack")).toBe(false);
  expect(statuses.at(-1)).toEqual(["lobby", "Returned to room"]);
});

test("leaving between catch-up batches stops C replay and suppresses its acknowledgement", async () => {
  const { first, port, engine, statuses } = await setup();
  first.onerror(new NetworkConnectionError("connection lost"));
  const next = await nextConnection();
  next.resumeTarget = () => 84;
  await downloadSnapshot(next, 84);
  const ends = mock(() => {});
  engine._WebNetEndReplay = ends;
  const step = mock((tick: number) => {
    port.netMatch = { tick: tick + 1, ...state };
    return 1;
  });
  engine._WebNetQueueTick = step;
  engine.ccall = () => 3;
  const width = 118 + start.capacity * 7;
  const bytes = new Uint8Array(64 * width);
  const view = new DataView(bytes.buffer);
  for (let row = 0; row < bytes.length; row += width) {
    view.setUint32(row, state.digest, true);
    state.sections.forEach((value, index) => view.setUint32(row + 4 * (index + 1), value, true));
  }
  next.onmessage({
    type: "catchup_frames",
    attempt: 1,
    start: 20,
    head: 84,
    data: [...bytes],
    checksum: checksum(bytes),
  });
  const steps = step.mock.calls.length;
  expect(steps).toBeGreaterThan(0);
  expect(steps).toBeLessThanOrEqual(24);
  stop!();
  await Bun.sleep(10);
  expect(step).toHaveBeenCalledTimes(steps);
  expect(ends).toHaveBeenCalledTimes(1);
  expect(next.sent.some((message) => message.type === "catchup_applied")).toBe(false);
  expect(statuses.at(-1)).toEqual(["lobby", "Returned to room"]);
});

test("failed preparation releases prediction and the C match through the same teardown", async () => {
  const { first, statuses, counts } = await setup();
  first.onerror(new NetworkConnectionError("connection lost"));
  const next = await nextConnection();
  next.onmessage({ type: "welcome", slot: 0 });
  next.preparePrediction = () => {
    throw new Error("preparation failed");
  };
  next.onmessage({ type: "resume_prepare", ...start });
  await Promise.resolve();
  expect(globalThis.tm4LivePrediction).toBeUndefined();
  expect(next.readyState).toBe(WebSocket.CLOSED);
  expect(counts()).toEqual({ cancellations: 2, loads: 1 });
  expect(statuses.at(-1)).toEqual(["error", "preparation failed"]);
});

test("a late connection after leaving is closed without restarting the session", async () => {
  const { first, statuses } = await setup();
  let release!: () => void;
  connectionPending = new Promise<void>((resolve) => {
    release = resolve;
  });
  first.onerror(new NetworkConnectionError("connection lost"));
  await Bun.sleep(550);
  const next = connections[1]!;
  stop!();
  release();
  await Bun.sleep(0);
  expect(next.readyState).toBe(WebSocket.CLOSED);
  expect(next.sent).toEqual([]);
  expect(statuses.at(-1)).toEqual(["lobby", "Returned to room"]);
});

test("cancelling initial connection closes its late transport without attaching prediction", async () => {
  let release!: () => void;
  connectionPending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const joining = setup(undefined, controller.signal);
  controller.abort(new Error("Room cancelled"));
  release();
  await expect(joining).rejects.toThrow("Room cancelled");
  expect(connections[0]!.readyState).toBe(WebSocket.CLOSED);
  expect(connections[0]!.sent).toEqual([]);
  expect(globalThis.tm4LivePrediction).toBeUndefined();
});

test("abort followed by a new join cannot tear down the replacement match", async () => {
  const controller = new AbortController();
  const { first, engine, port, counts } = await setup(undefined, controller.signal);
  controller.abort();
  const statuses: [string, string][] = [];
  stop = await joinMatch(
    engine,
    "wss://game.test/match",
    (phase, message) => {
      statuses.push([phase, message]);
    },
    () => {},
  );
  const next = connections[1]!;
  next.onopen();
  next.onmessage({ type: "welcome", slot: 0 });
  next.onmessage({ type: "prediction_prepare", ...start });
  next.onmessage({ type: "prediction_offer", anchor: 100 });
  next.onmessage({ type: "prediction_begin", anchor: 100 });
  first.onerror(new Error("Old transport failed"));
  await Promise.resolve();
  expect(counts()).toEqual({ cancellations: 1, loads: 2 });
  expect(globalThis.tm4LivePrediction).toBeDefined();
  expect(port.netMatch).toBeDefined();
  expect(next.readyState).toBe(WebSocket.OPEN);
  expect(statuses.at(-1)?.[0]).toBe("playing");
});

test("external cancellation stops snapshot recovery and scheduled reconnects", async () => {
  const controller = new AbortController();
  const { first, engine, port } = await setup(undefined, controller.signal);
  first.onerror(new NetworkConnectionError("connection lost"));
  const next = await nextConnection();
  await downloadSnapshot(next);
  const end = mock(() => {});
  engine._WebNetEndReplay = end;
  controller.abort();
  await Promise.resolve();
  expect(end).toHaveBeenCalledTimes(1);
  expect(next.readyState).toBe(WebSocket.CLOSED);
  expect(port.netMatchInput).toBeUndefined();
  expect(globalThis.tm4LivePrediction).toBeUndefined();
  await Bun.sleep(1100);
  expect(connections).toHaveLength(2);
});

test("an abandoned initial join resolving after a new match cannot cancel the new C state", async () => {
  const { engine, port, counts } = await setup();
  stop!();
  await Promise.resolve();
  let release!: () => void;
  connectionPending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const abandoned = joinMatch(
    engine,
    "wss://game.test/old",
    () => {},
    () => {},
    undefined,
    controller.signal,
  );
  controller.abort(new Error("Superseded"));
  connectionPending = undefined;
  stop = await joinMatch(
    engine,
    "wss://game.test/new",
    () => {},
    () => {},
  );
  const next = connections[2]!;
  next.onopen();
  next.onmessage({ type: "welcome", slot: 0 });
  next.onmessage({ type: "prediction_prepare", ...start });
  next.onmessage({ type: "prediction_offer", anchor: 100 });
  next.onmessage({ type: "prediction_begin", anchor: 100 });
  const prediction = globalThis.tm4LivePrediction;
  release();
  await expect(abandoned).rejects.toThrow("Superseded");
  expect(connections[1]!.readyState).toBe(WebSocket.CLOSED);
  expect(globalThis.tm4LivePrediction).toBe(prediction);
  expect(port.netMatch).toBeDefined();
  expect(counts()).toEqual({ cancellations: 1, loads: 2 });
  expect(next.readyState).toBe(WebSocket.OPEN);
});
