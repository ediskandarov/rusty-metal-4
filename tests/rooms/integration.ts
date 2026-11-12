import assert from "node:assert/strict";

import { WebSocket as NetworkWebSocket } from "ws";

import type { RoomSnapshot, RoomSummary } from "../../apps/rustymetal4.com/src/protocol.ts";
import { eventually, runtime } from "./runtime.ts";

const mf = await runtime();
const origin = (await mf.ready).origin;
const sockets: { close(): void }[] = [];
const options = {
  name: "Integration crew",
  playerName: "Host",
  requestId: `${Date.now()}.${crypto.randomUUID()}`,
};
function browser() {
  let cookie = "";
  return {
    async request(path: string, body?: unknown, headers: Record<string, string> = {}) {
      const response = await mf.dispatchFetch(`${origin}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const issued = response.headers.get("set-cookie");
      if (issued) cookie = issued.split(";")[0]!;
      return response;
    },
    get cookie() {
      return cookie;
    },
  };
}
try {
  const a = browser(),
    b = browser(),
    c = browser();
  for (const client of [a, b, c]) assert.equal((await client.request("session", {})).status, 200);
  assert(a.cookie.length > 60);
  assert.equal((await a.request("rooms", options, { Origin: "https://other.test" })).status, 403);
  assert.equal((await a.request("rooms", { ...options, name: "" })).status, 400);
  const [first, retry] = await Promise.all([
    a.request("rooms", options),
    a.request("rooms", options),
  ]);
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  const initial = ((await first.json()) as { room: RoomSnapshot }).room;
  assert.equal(
    ((await retry.json()) as { room: RoomSnapshot }).room.id,
    initial.id,
    "creation retry is idempotent",
  );
  assert.equal(initial.modeId, "deathmatch");
  assert.equal(initial.mapId, "construction-yard");
  assert.equal(initial.capacity, 8);
  assert.equal(initial.freePlaces, 7);
  const configured = {
    name: options.name,
    modeId: "deathmatch",
    mapId: "construction-yard",
    capacity: 2,
  };
  const id = initial.id,
    path = `rooms/${id}`;
  const view = async (client = a) =>
    ((await (await client.request(path)).json()) as { room: RoomSnapshot }).room;
  async function socket(client: ReturnType<typeof browser>, endpoint = path) {
    const url = new URL(`/api/${endpoint}/live`, origin);
    url.protocol = "ws:";
    const ws = new NetworkWebSocket(url.href, {
      headers: { Origin: origin, Cookie: client.cookie },
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = reject;
    });
    sockets.push(ws);
    return ws;
  }
  const old = await socket(a),
    current = await socket(a);
  old.close();
  await eventually(view, (room) => room.participants[0]!.connected);
  assert.equal((await a.request(`${path}/settings`, configured)).status, 200);
  assert.equal(
    (await a.request(`${path}/settings`, { ...configured, modeId: "future-mode" })).status,
    400,
  );
  const [joinB, joinC] = await Promise.all([
    b.request(`${path}/join`, { playerName: "Guest B" }),
    c.request(`${path}/join`, { playerName: "Guest C" }),
  ]);
  assert.deepEqual(
    [joinB.status, joinC.status].sort(),
    [200, 409],
    "only one concurrent join wins the last slot",
  );
  const guest = joinB.ok ? b : c;
  const guestSocket = await socket(guest);
  assert.equal((await view()).participantCount, 2);
  assert.equal(
    (await guest.request(`${path}/settings`, { ...configured, capacity: 8 })).status,
    403,
  );
  assert.equal((await a.request(`${path}/settings`, { ...configured, capacity: 1 })).status, 400);
  assert.equal(
    (
      await a.request(`${path}/settings`, {
        ...configured,
        name: "Shared changes",
        mapId: "the-oil-rig",
      })
    ).status,
    200,
  );
  assert.equal((await view(guest)).mapId, "the-oil-rig");
  const directory = JSON.stringify(await (await a.request("rooms")).json());
  assert(!directory.includes(a.cookie.split("=")[1]!));
  assert(!directory.includes("creatorKey"));
  assert(!directory.includes("connections"));
  await mf.unsafeEvictDurableObject("room-tests", "Room", { name: id, webSockets: "hibernate" });
  assert.equal(
    (await view()).you,
    initial.you,
    "eviction restores identity and hibernating sockets",
  );
  assert.equal((await view()).hostId, initial.hostId);
  current.close();
  const reconnect = await socket(a);
  await Bun.sleep(150);
  assert.equal(
    (await view()).participants.find((member) => member.id === initial.you)!.connected,
    true,
  );
  assert.equal((await a.request(`${path}/leave`, {})).status, 200);
  const transferred = await view(guest);
  assert.equal(transferred.hostId, transferred.you, "explicit host leave transfers ownership");
  assert.equal(transferred.freePlaces, 1);
  assert.equal((await a.request(`${path}/settings`, options)).status, 403);
  reconnect.close();
  guestSocket.close();
  const timeoutOptions = {
    ...options,
    name: "Host timeout",
    requestId: `${Date.now()}.${crypto.randomUUID()}`,
  };
  const timeoutResponse = await a.request("rooms", timeoutOptions);
  assert.equal(timeoutResponse.status, 200);
  const timeoutId = ((await timeoutResponse.json()) as { room: RoomSnapshot }).room.id;
  const timeoutPath = `rooms/${timeoutId}`;
  const timeoutHost = await socket(a, timeoutPath);
  assert.equal((await b.request(`${timeoutPath}/join`, { playerName: "Successor" })).status, 200);
  const successorSocket = await socket(b, timeoutPath);
  timeoutHost.close();
  const timeoutView = async () =>
    ((await (await b.request(timeoutPath)).json()) as { room: RoomSnapshot }).room;
  const namespace = (await mf.getDurableObjectNamespace("ROOMS")) as unknown as {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): unknown;
  };
  const room = namespace.get(namespace.idFromName(id)) as {
    inspectForTest(): Promise<{ entries: unknown[]; alarm: number | null; sockets: number }>;
  };
  const directoryNamespace = (await mf.getDurableObjectNamespace("DIRECTORY")) as unknown as {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): unknown;
  };
  const directoryObject = directoryNamespace.get(directoryNamespace.idFromName("public")) as {
    setUnavailableForTest(value: boolean): Promise<void>;
    expireListingsForTest(): Promise<void>;
    inspectDirectoryForTest(): Promise<{ entries: unknown[]; alarm: number | null }>;
  };
  const silentResponse = await a.request("rooms", {
    ...options,
    name: "Silent connection",
    requestId: `${Date.now()}.${crypto.randomUUID()}`,
  });
  assert.equal(silentResponse.status, 200);
  const silentInitial = ((await silentResponse.json()) as { room: RoomSnapshot }).room;
  const silentPath = `rooms/${silentInitial.id}`;
  const silentSocket = await socket(a, silentPath);
  const silentRoom = namespace.get(namespace.idFromName(silentInitial.id)) as {
    ageSilentSocketsForTest(): Promise<void>;
  };
  await silentRoom.ageSilentSocketsForTest();
  const silentView = async () =>
    ((await (await a.request(silentPath)).json()) as { room: RoomSnapshot }).room;
  await eventually(silentView, (state) => !state.participants[0]!.connected);
  const returnedSocket = await socket(a, silentPath);
  assert.equal((await silentView()).you, silentInitial.you);
  assert.equal((await silentView()).participantCount, 1);
  assert.equal((await a.request(`${silentPath}/leave`, {})).status, 200);
  silentSocket.close();
  returnedSocket.close();
  const persisted = await room.inspectForTest();
  assert(persisted.entries.length && persisted.alarm, "disconnect deadlines are persisted");
  console.log(
    "PASS real Worker sessions, creation retries, capacity race, settings permissions, socket races, hibernation, silent-socket expiry and host transfer",
  );
  await eventually(view, (state) => state.participantCount === 0, 48_000);
  await eventually(
    timeoutView,
    (state) => state.participantCount === 1 && state.hostId === state.you,
  );
  assert.equal((await b.request(`${timeoutPath}/leave`, {})).status, 200);
  successorSocket.close();
  console.log(
    "PASS real reconnect grace and disconnected-host succession; waiting for empty cleanup and directory failure recovery",
  );
  await directoryObject.setUnavailableForTest(true);
  await eventually(
    () => room.inspectForTest(),
    (state) => Boolean((state.entries[0] as [string, { closed: boolean }])?.[1]?.closed),
    33_000,
  );
  const retryAlarm = (await room.inspectForTest()).alarm;
  assert(
    retryAlarm !== null && retryAlarm > Date.now(),
    "failed directory removal schedules a future retry without an alarm loop",
  );
  await directoryObject.setUnavailableForTest(false);
  await eventually(
    () => room.inspectForTest(),
    (state) => state.entries.length === 0 && state.alarm === null,
    7000,
  );
  const timeoutRoom = namespace.get(namespace.idFromName(timeoutId)) as {
    inspectForTest(): Promise<{ entries: unknown[]; alarm: number | null }>;
  };
  await eventually(
    () => timeoutRoom.inspectForTest(),
    (state) => !state.entries.length && state.alarm === null,
    7000,
  );
  const empty = await room.inspectForTest();
  assert.equal(empty.sockets, 0);
  assert.equal((await a.request(path)).status, 404);
  assert.equal((await a.request(`${path}/join`, { playerName: "Late" })).status, 404);
  assert.equal(
    (await a.request("rooms", options)).status,
    410,
    "old creation retry cannot recreate a deleted room",
  );
  assert.equal((await room.inspectForTest()).entries.length, 0);
  assert.equal(
    ((await (await a.request("rooms")).json()) as { rooms: RoomSummary[] }).rooms.length,
    0,
  );
  console.log(
    "PASS persisted alarms, retry after directory outage, complete storage/alarm/socket cleanup, late invites and stale creation retries",
  );
  // Creation limits are enforced by the real runtime binding, including a fresh cookie on the same address.
  for (let index = 0; index < 5; index++)
    await c.request("rooms", { ...options, requestId: `${Date.now()}.${crypto.randomUUID()}` });
  await c.request("session", {});
  assert.equal(
    (await c.request("rooms", { ...options, requestId: `${Date.now()}.${crypto.randomUUID()}` }))
      .status,
    429,
  );
  console.log("PASS bounded room creation");
  await directoryObject.expireListingsForTest();
  assert.equal(
    ((await (await a.request("rooms")).json()) as { rooms: RoomSummary[] }).rooms.length,
    0,
  );
  const directoryEmpty = await directoryObject.inspectDirectoryForTest();
  assert.equal(directoryEmpty.entries.length, 0);
  assert.equal(directoryEmpty.alarm, null);
  console.log(
    "PASS expired directory leases remove summaries, stored records and the empty index alarm",
  );
} finally {
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      /* The server may already have closed this socket. */
    }
  }
  await mf.dispose();
}
