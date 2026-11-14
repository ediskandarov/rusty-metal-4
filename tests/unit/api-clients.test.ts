import { expect, test } from "bun:test";

import { openDisc } from "@tm4/dev-server-client";
import { diagnosticsSchema, messageSchema, requestSchema } from "@tm4/lightyear-client/schemas";
import { createRoomsClient, RoomsApiError } from "@tm4/rooms-client";
import { roomEventSchema } from "@tm4/rooms-client/schemas";
import { createServerClient, ServerApiError } from "@tm4/rustymetal-server-client";

import { createState, snapshot } from "../../apps/rustymetal4.com/src/room-state.ts";

const id = "a".repeat(32);
const room = () =>
  snapshot(createState(id, "host", { name: "Room", playerName: "Host" }, Date.now()), "host");
const status = {
  phase: "setup",
  sessionId: null,
  cars: [],
  compatibility: null,
  message: "Upload resources",
  players: 2,
  limits: { timeLimitTicks: 27000, fragLimit: 20 },
  worlds: [],
  world: null,
  connected: 0,
  tick: 0,
  endpoint: "/match",
  uploaded: 0,
  required: 1,
};

test("room client validates responses and preserves HTTP errors for recovery", async () => {
  let response = Response.json({ room: room() });
  const seen: Request[] = [];
  const client = createRoomsClient({
    baseURL: "https://game.test/api/",
    fetch: (request) => {
      seen.push(request);
      return Promise.resolve(response);
    },
  });
  expect((await client.get(id)).id).toBe(id);
  expect(seen[0]!.url).toBe("https://game.test/api/rooms/" + id);
  response = Response.json({ room: { ...room(), capacity: "8" } });
  await expect(client.get(id)).rejects.toThrow();
  response = Response.json({ error: "Room expired" }, { status: 410 });
  try {
    await client.get(id);
    throw new Error("Request must fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RoomsApiError);
    expect((error as RoomsApiError).status).toBe(410);
    expect((error as Error).message).toBe("Room expired");
  }
  response = new Response("Gateway unavailable", { status: 503 });
  await expect(client.list()).rejects.toBeInstanceOf(RoomsApiError);
  const before = seen.length;
  await expect(client.get("../outside")).rejects.toThrow();
  expect(seen.length).toBe(before);
});

test("room uploads use their scoped URL and retain exact binary bytes", async () => {
  const bytes = new Uint8Array([0, 255, 42]);
  let uploaded: Uint8Array | undefined;
  let url = "";
  const client = createRoomsClient({
    baseURL: "https://game.test/api",
    fetch: async (request) => {
      url = request.url;
      uploaded = new Uint8Array(await request.arrayBuffer());
      return new Response(null, { status: 204 });
    },
  });
  const session = crypto.randomUUID();
  const resources = client.resources(id, session);
  await resources.upload("/DATA/MENU/CAD.MR", bytes);
  expect(url).toBe(
    "https://game.test/api/rooms/" + id + "/match/" + session + "/resources/DATA/MENU/CAD.MR",
  );
  expect(uploaded).toEqual(bytes);
  await expect(resources.upload("/DATA/../secret", bytes)).rejects.toThrow();
});

test("server client parses status, applies admin headers, and forwards cancellation", async () => {
  const requests: Request[] = [];
  let response = Response.json(status);
  const client = createServerClient({
    baseURL: "http://server/api",
    headers: () => ({ Authorization: "Bearer admin" }),
    fetch: (request) => {
      requests.push(request);
      return Promise.resolve(response);
    },
  });
  const controller = new AbortController();
  expect((await client.status(controller.signal)).sessionId).toBeNull();
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer admin");
  controller.abort();
  expect(requests[0]!.signal.aborted).toBe(true);
  response = Response.json({ ...status, tick: "bad" });
  await expect(client.status()).rejects.toThrow();
  response = new Response("Busy", { status: 503 });
  await expect(client.status()).rejects.toBeInstanceOf(ServerApiError);
  response = new Response(null, { status: 202 });
  await client.start({
    players: 2,
    limits: { timeLimitTicks: 27000, fragLimit: 20 },
    world: "Construction Yard",
  });
  expect(await requests.at(-1)!.json()).toEqual({
    players: 2,
    limits: { timeLimitTicks: 27000, fragLimit: 20 },
    world: "Construction Yard",
  });
  await expect(
    client.start({
      players: 2,
      limits: { timeLimitTicks: 27000, fragLimit: 20 },
      world: "Construction Yard",
      sessionId: crypto.randomUUID(),
      roster: [],
    }),
  ).rejects.toThrow();
});

test("room subscription rejects malformed events and reconnects with validated snapshots", async () => {
  let connections = 0,
    recoveries = 0,
    updates = 0;
  let complete: () => void = () => {};
  const received = new Promise<void>((resolve) => (complete = resolve));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(socket) {
        connections++;
        socket.send(
          JSON.stringify(
            connections === 1 ? { type: "room", room: { id } } : { type: "room", room: room() },
          ),
        );
      },
      message(socket, message) {
        if (message === "ping") socket.send("pong");
      },
    },
  });
  let close = () => {};
  try {
    const client = createRoomsClient({ baseURL: new URL("/api/", server.url) });
    close = client.watchRoom(id, {
      update: (value) => {
        updates++;
        expect(value.id).toBe(id);
        complete();
      },
      status: () => {},
      recover: () => {
        recoveries++;
        return Promise.resolve(true);
      },
    });
    await received;
    expect(connections).toBe(2);
    expect(recoveries).toBe(1);
    expect(updates).toBe(1);
  } finally {
    close();
    await server.stop(true);
  }
}, 8000);

test("disc client validates manifests, exact ranges, and same-origin resource URLs", async () => {
  let mode = "valid";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/manifest")
        return Response.json({
          files: [
            {
              name: "disc.bin",
              size: mode === "bad-size" ? -1 : 4,
              url: mode === "foreign" ? "https://elsewhere.test/disc.bin" : "disc.bin",
            },
          ],
        });
      expect(request.headers.get("range")).toBe("bytes=1-2");
      return new Response(new Uint8Array([2, 3]), {
        status: 206,
        headers: { "Content-Range": mode === "bad-range" ? "bytes 0-1/4" : "bytes 1-2/4" },
      });
    },
  });
  try {
    const disc = await openDisc(new URL("manifest", server.url));
    expect(disc.warnings).toEqual([]);
    expect(await disc.files[0]!.read(1, 2)).toEqual(new Uint8Array([2, 3]));
    mode = "bad-range";
    await expect(disc.files[0]!.read(1, 2)).rejects.toThrow("Invalid range");
    mode = "bad-size";
    await expect(openDisc(new URL("manifest", server.url))).rejects.toThrow();
    mode = "foreign";
    await expect(openDisc(new URL("manifest", server.url))).rejects.toThrow("local server");
  } finally {
    await server.stop(true);
  }
});

test("Lightyear bridge schemas reject malformed envelopes and accept disconnected diagnostics", () => {
  expect(messageSchema.parse({ type: "welcome", slot: 7 })).toEqual({ type: "welcome", slot: 7 });
  for (const value of [
    { type: "welcome", slot: 8 },
    { type: "welcome", slot: 0.5 },
    { type: "resume_credential", token: "invalid" },
    { type: "snapshot_chunk", attempt: 1, offset: 0, data: [] },
    { type: "snapshot_chunk", attempt: 1, offset: 0, data: [256] },
    { type: "snapshot_chunk", attempt: 1, offset: 0, data: new Array(8193).fill(0) },
    { type: "unknown" },
    { type: "frame", tick: 1, inputs: [], state: {} },
  ])
    expect(messageSchema.safeParse(value).success).toBe(false);
  expect(requestSchema.safeParse({ type: "progress", tick: -1 }).success).toBe(false);
  expect(roomEventSchema.safeParse({ type: "room", room: room() }).success).toBe(true);
  const diagnostics = diagnosticsSchema.parse({
    rttSamples: 0,
    rttMs: null,
    jitterMs: null,
    queuedPackets: null,
    nativeTick: 0,
    nativeRoster: [],
    prediction: {
      head: 0,
      confirmed: 0,
      rollbacks: 0,
      windowWaits: 0,
      waitingForInput: false,
      acceptedDepth: 0,
      confirmedNativeTick: null,
      resumePreparing: false,
      expectedSlotMask: null,
      expectedParticipants: [],
      replayed: 0,
      maxDepth: 0,
      historyBytes: 0,
      peakBytes: 0,
      buttonEdges: 0,
    },
  });
  expect(diagnostics.rttMs).toBeNull();
  expect(
    diagnosticsSchema.parse({
      ...diagnostics,
      prediction: { ...diagnostics.prediction, acceptedDepth: -14 },
    }).prediction.acceptedDepth,
  ).toBe(-14);
});

test("snapshot header limits are enforced at the Lightyear boundary", () => {
  const header = {
    type: "snapshot_begin",
    attempt: 1,
    tick: 20,
    anchor: 100,
    total: 256 * 1024,
    checksum: 0,
    state: {
      remaining: 2,
      winner: -1,
      completion: { tick: 0, reasons: 0, winners: 0 },
      roundFinished: false,
      acceptsContinue: false,
      nextMode: 0,
      digest: 0,
      sections: [0, 0, 0, 0, 0],
      unsupported: null,
      scores: [],
    },
  };
  expect(messageSchema.safeParse(header).success).toBe(true);
  for (const change of [{ tick: 0 }, { tick: 1.5 }, { total: 0 }, { total: 256 * 1024 + 1 }])
    expect(messageSchema.safeParse({ ...header, ...change }).success).toBe(false);
});
