import { afterEach, expect, mock, test } from "bun:test";

import { clientJournal } from "@tm4/game-runtime/network/journal";
import type { NetworkPort } from "@tm4/game-runtime/network/protocol";
import { checksum } from "@tm4/game-runtime/network/replay";
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
mock.module("../../packages/game-runtime/src/network/transport.ts", () => ({
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

const compatibility = { protocol: 9, build: "build", content: "content" };
const start = {
  players: 2,
  world: "Road Rage",
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
    { wins: 0, losses: 0 },
    { wins: 0, losses: 0 },
  ],
};
async function setup(diagnostics?: Connection["diagnostics"]) {
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
    ccall: (name: string) => (name === "WebNetWorldIndex" ? 0 : 1),
    _WebNetRequestMatch() {
      loads++;
      port.netMatch = { tick: 0, ...state };
      return 1;
    },
    _WebNetCancelMatch() {
      cancellations++;
      delete port.netMatch;
    },
    _WebNetEnableRenderedPrediction: () => 1,
    _WebNetEnablePortableCheckpoint: () => 1,
    _WebNetLocalRollbackDepth: () => 12,
    _WebNetSetInput: () => 1,
    _WebNetQueueTick: () => 1,
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
  return { page, window, port, first, statuses, counts: () => ({ cancellations, loads }) };
}
async function nextConnection() {
  await Bun.sleep(550);
  expect(connections).toHaveLength(2);
  const next = connections[1]!;
  next.onopen();
  expect(next.sent[0]).toEqual({ type: "resume", token, compatibility });
  return next;
}
async function downloadSnapshot(next: Connection) {
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
  next.onmessage({ type: "snapshot_chunk", attempt: 1, offset: 0, data: [...bytes] });
  await Promise.resolve();
  expect(next.sent).toContainEqual({ type: "resume_clock", attempt: 1, target: 20 });
  next.onmessage({ type: "resume_catchup", attempt: 1, start: 20, head: 20, digest: 42 });
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
  await Bun.sleep(550);
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
  await Bun.sleep(550);
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
  first.onmessage({ type: "frame", tick: 0, inputs: [], state });
  expect(port.netConfirmedTick).toBe(1);
  expect(first.readyState).toBe(WebSocket.OPEN);
  expect(port.netDiagnostics?.transportError).toBe("diagnostics unavailable");
  expect(port.netDiagnostics?.transport).toBeUndefined();

  first.diagnostics = () => ({});
  first.onmessage({ type: "frame", tick: 1, inputs: [], state });
  expect(port.netConfirmedTick).toBe(2);
  expect(port.netDiagnostics?.transportError).toBeUndefined();
});

test("diagnostic failures do not block snapshot recovery or replace transport errors", async () => {
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
  next.onerror(new Error("connection lost"));
  expect(statuses.at(-1)).toEqual(["error", "connection lost"]);
  expect(clientJournal()?.export().stopped).toBe("connection lost");
});

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
