import assert from "node:assert/strict";

import type { RoomSnapshot } from "@tm4/rooms-client/schemas";

import { monitoringGrace, type RoomMatch } from "../../apps/rustymetal4.com/src/room-state.ts";
import { eventually, runtime } from "./runtime.ts";
const mf = await runtime();
const origin = (await mf.ready).origin;
import { networkProtocolVersion } from "@tm4/lightyear-client/schemas";
const compatibility = {
  protocol: networkProtocolVersion,
  build: "a".repeat(64),
  content: "b".repeat(64),
};
const sockets: { close(): void }[] = [];
const browsers = Array.from({ length: 3 }, () => {
  let cookie = "";
  return async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    headers: Record<string, string> = {},
  ) => {
    const response = await mf.dispatchFetch(origin + "/api/" + path, {
      method,
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", ...headers },
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return response;
  };
});
const [host, guest, stranger] = browsers as [
  (typeof browsers)[number],
  (typeof browsers)[number],
  (typeof browsers)[number],
];
type Namespace = { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): unknown };
const namespace = (await mf.getDurableObjectNamespace("SERVER")) as unknown as Namespace;
type Server = {
  configureForTest(value: object): Promise<void>;
  inspectForTest(): Promise<{ stops: number; roster: unknown[] }>;
  cancelAdmissionsForTest(): Promise<void>;
};
try {
  for (const browser of browsers) await browser("session", {});
  const create = await host("rooms", {
    name: "Lifecycle",
    playerName: "Host",
    requestId: Date.now() + "." + crypto.randomUUID(),
  });
  const initial = ((await create.json()) as { room: RoomSnapshot }).room;
  const path = "rooms/" + initial.id;
  const view = async () => ((await (await host(path)).json()) as { room: RoomSnapshot }).room;
  await guest(path + "/join", { playerName: "Guest" });
  for (const browser of [host, guest]) {
    const response = await browser(path + "/live", undefined, "GET", { Upgrade: "websocket" });
    assert.equal(response.status, 101);
    response.webSocket!.accept();
    sockets.push(response.webSocket!);
  }
  const rooms = (await mf.getDurableObjectNamespace("ROOMS")) as unknown as Namespace;
  const room = rooms.get(rooms.idFromName(initial.id)) as {
    expireMatchForTest(): Promise<void>;
    expireDisconnectedForTest(memberId: string): Promise<void>;
    emptyMatchForTest(): Promise<void>;
    checkMatchForTest(): Promise<RoomMatch | undefined>;
    restoreMatchFromStorageForTest(): Promise<RoomMatch | undefined>;
  };
  for (const browser of [host, guest])
    assert.equal(
      (await browser(path + "/player", { car: "Orbital", compatibility, ready: false })).status,
      200,
    );
  assert.equal((await guest(path + "/prepare", {})).status, 403);
  assert.equal((await host(path + "/prepare", {})).status, 200);
  let match = (await view()).match!;
  const server = () => namespace.get(namespace.idFromName(initial.id + ":" + match.id)) as Server;
  assert.equal((await guest(path + "/match/" + match.id + "/resources")).status, 403);
  assert.equal((await stranger(path + "/match/" + match.id + "/resources")).status, 403);
  assert.equal(
    (await host(path + "/match/" + match.id + "/resources/DATA/MENU/CAD.MR", "fixture", "PUT"))
      .status,
    200,
  );
  assert.equal((await host(path + "/match/" + match.id + "/prepare", {})).status, 202);
  await eventually(view, (state) => state.match?.stage === "ready");
  for (const browser of [host, guest])
    assert.equal(
      (await browser(path + "/player", { car: "Orbital", compatibility, ready: true })).status,
      200,
    );
  const [startA, startB] = await Promise.all([
    host(path + "/start", {}),
    host(path + "/start", {}),
  ]);
  assert.deepEqual([startA.status, startB.status].sort(), [200, 409]);
  assert.equal((await stranger(path + "/join", { playerName: "Late" })).status, 409);
  assert.equal((await guest(path + "/join", { playerName: "Guest" })).status, 200);
  assert.equal((await server().inspectForTest()).roster.length, 2);
  await eventually(view, (state) => state.match?.stage === "playing");
  assert.equal((await stranger(path + "/join", { playerName: "Late" })).status, 200);
  assert.equal(
    (await stranger(path + "/player", { car: "Pizza Boy", compatibility, ready: true })).status,
    409,
    "late admission is limited to the declared prepared pool",
  );
  const lateMember = ((await (await stranger(path)).json()) as { room: RoomSnapshot }).room.you!;
  assert.equal(
    (await stranger(path + "/player", { car: "Orbital", compatibility, ready: false })).status,
    200,
  );
  assert.equal(
    (await stranger(path + "/player", { car: "Orbital", compatibility, ready: true })).status,
    200,
  );
  const pending = (await room.checkMatchForTest())!.roster.find(
    (entry) => entry.id === lateMember,
  )!;
  assert(pending.pending);
  await server().cancelAdmissionsForTest();
  await server().configureForTest({ lookupFailure: true });
  const lookupOutage = (await room.checkMatchForTest())!;
  const lookupDeadline = lookupOutage.monitoringUnavailableUntil;
  assert(lookupDeadline !== null && lookupDeadline > Date.now());
  assert(
    lookupOutage.roster.some((entry) => entry.id === lateMember),
    "monitoring failure cannot establish cancellation",
  );
  await Bun.sleep(30);
  assert.equal(
    (await room.checkMatchForTest())!.monitoringUnavailableUntil,
    lookupDeadline,
    "healthy general status cannot renew a failed membership lookup's deadline",
  );
  const reloadedLookupOutage = (await room.restoreMatchFromStorageForTest())!;
  assert.equal(reloadedLookupOutage.monitoringUnavailableUntil, lookupDeadline);
  await Bun.sleep(30);
  assert.equal(
    (await room.checkMatchForTest())!.monitoringUnavailableUntil,
    lookupDeadline,
    "partial monitoring failures retain the first deadline across durable reload",
  );
  await server().configureForTest({ lookupFailure: false });
  const reconciled = (await room.checkMatchForTest())!;
  assert.equal(
    reconciled.monitoringUnavailableUntil,
    null,
    "successful reconciliation clears the outage deadline before its commit return",
  );
  assert(!reconciled.roster.some((entry) => entry.id === lateMember));
  let lateView = ((await (await stranger(path)).json()) as { room: RoomSnapshot }).room;
  assert.equal(lateView.match!.credential, null);
  assert.equal(lateView.participants.find((entry) => entry.id === lateMember)!.ready, false);
  assert.equal(
    (await stranger(path + "/player", { car: "Orbital", compatibility, ready: true })).status,
    200,
  );
  const retried = (await room.checkMatchForTest())!.roster.find(
    (entry) => entry.id === lateMember,
  )!;
  assert.notEqual(retried.credential, pending.credential);
  await room.expireDisconnectedForTest(lateMember);
  assert(
    (await view()).participants.some((entry) => entry.id === lateMember),
    "pending native lease retains room membership until authoritative cancellation",
  );
  await server().cancelAdmissionsForTest();
  await room.checkMatchForTest();
  lateView = await view();
  assert(
    !lateView.participants.some((entry) => entry.id === lateMember),
    "canceled disconnected preparation is pruned",
  );
  console.log(
    "PASS authoritative preparation cancellation, monitoring outage, same-member retry and disconnected pruning",
  );
  const journalPath = path + "/match/" + match.id + "/journal";
  assert.equal((await guest(journalPath)).status, 403);
  assert.equal((await stranger(journalPath)).status, 403);
  const liveJournal = await host(journalPath);
  assert.equal(liveJournal.status, 200);
  const journalBytes = await liveJournal.arrayBuffer();
  assert.equal(journalBytes.byteLength, 11);
  assert.match(liveJournal.headers.get("content-disposition")!, /attachment/);
  const firstServer = server();
  const firstId = match.id;
  const directoryNamespace = (await mf.getDurableObjectNamespace(
    "DIRECTORY",
  )) as unknown as Namespace;
  const directory = directoryNamespace.get(directoryNamespace.idFromName("public")) as {
    reserveMatch(room: string, session: string): Promise<boolean>;
    releaseMatch(room: string, session: string): Promise<void>;
    setReservationUnavailableForTest(value: boolean): Promise<void>;
    reservationForTest(room: string): Promise<{ session: string; until: number } | undefined>;
  };
  const fixed = (await room.checkMatchForTest())!;
  for (const failure of ["http", "timeout", "reservation"] as const) {
    if (failure === "reservation") await directory.setReservationUnavailableForTest(true);
    else await firstServer.configureForTest({ statusFailure: failure });
    const failed = (await room.checkMatchForTest())!;
    assert.equal(failed.id, firstId);
    assert.equal(failed.stage, "playing");
    assert.deepEqual(failed.roster, fixed.roster);
    assert(
      failed.monitoringUnavailableUntil !== null && failed.monitoringUnavailableUntil > Date.now(),
    );
    assert.equal(
      (await firstServer.inspectForTest()).stops,
      0,
      failure + " must not stop a healthy match",
    );
    assert.equal((await directory.reservationForTest(initial.id))?.session, firstId);
    const restored = (await room.restoreMatchFromStorageForTest())!;
    assert.equal(
      restored.monitoringUnavailableUntil,
      failed.monitoringUnavailableUntil,
      "outage deadline survives durable-state reload",
    );
    await firstServer.configureForTest({ statusFailure: null });
    await directory.setReservationUnavailableForTest(false);
    const recovered = (await room.checkMatchForTest())!;
    assert.equal(recovered.monitoringUnavailableUntil, null);
    assert.equal(recovered.id, firstId);
    assert.deepEqual(recovered.roster, fixed.roster);
    assert.equal((await firstServer.inspectForTest()).stops, 0);
  }
  console.log(
    "PASS transient HTTP 503, real status timeout and reservation RPC failure recover without changing the match, roster or container",
  );
  await firstServer.configureForTest({ statusFailure: "http" });
  assert((await room.checkMatchForTest())!.monitoringUnavailableUntil);
  await firstServer.configureForTest({ phase: "results", failStop: true, statusFailure: null });
  await eventually(view, (state) => state.match?.stage === "stopping");
  assert.equal((await host(path + "/prepare", {})).status, 409);
  await firstServer.configureForTest({ failStop: false });
  const returned = await eventually(view, (state) => state.match === null);
  assert.equal(returned.journal?.matchId, firstId);
  assert.deepEqual(await (await host(journalPath)).arrayBuffer(), journalBytes);
  assert.equal((await guest(journalPath)).status, 403);
  console.log("PASS host-only server journal download before and after container stop");
  assert.equal(returned.id, initial.id);
  assert.equal(returned.participantCount, 2);
  assert(returned.participants.every((member) => !member.ready));
  assert.equal((await firstServer.inspectForTest()).stops, 1);
  assert.equal((await host(path + "/prepare", {})).status, 200);
  match = (await view()).match!;
  assert.notEqual(match.id, firstId);
  assert.equal((await host(path + "/match/" + firstId + "/prepare", {})).status, 409);
  await server().configureForTest({ failUpload: true });
  const failedServer = server();
  assert.equal(
    (await host(path + "/match/" + match.id + "/resources/DATA/MAIN.MR", "bad", "PUT")).status,
    400,
  );
  assert.equal((await view()).match, null);
  assert.equal((await failedServer.inspectForTest()).stops, 1);
  assert.equal((await host(path + "/prepare", {})).status, 200);
  match = (await view()).match!;
  const timeoutServer = server();
  await room.expireMatchForTest();
  await eventually(view, (state) => state.match === null);
  assert.equal((await timeoutServer.inspectForTest()).stops, 1);
  assert.equal((await host(path + "/prepare", {})).status, 200);
  match = (await view()).match!;
  assert.equal((await host(path + "/match/" + match.id + "/prepare", {})).status, 202);
  await eventually(view, (state) => state.match?.stage === "ready");
  for (const browser of [host, guest])
    assert.equal(
      (await browser(path + "/player", { car: "Orbital", compatibility, ready: true })).status,
      200,
    );
  assert.equal((await host(path + "/start", {})).status, 200);
  await eventually(view, (state) => state.match?.stage === "playing");
  const unavailableServer = server();
  await unavailableServer.configureForTest({ statusFailure: "http" });
  const outage = (await room.checkMatchForTest())!;
  const outageDeadline = outage.monitoringUnavailableUntil!;
  assert(outageDeadline > Date.now());
  await room.restoreMatchFromStorageForTest();
  const retry = (await room.checkMatchForTest())!;
  assert.equal(
    retry.monitoringUnavailableUntil,
    outageDeadline,
    "retries must not extend the outage grace",
  );
  assert.equal((await directory.reservationForTest(initial.id))?.session, match.id);
  await eventually(view, (state) => state.match === null, monitoringGrace + 5000);
  assert.equal((await unavailableServer.inspectForTest()).stops, 1);
  assert.equal(await directory.reservationForTest(initial.id), undefined);
  console.log(
    "PASS persisted monitoring grace expires under sustained unavailability and releases both container and reservation",
  );
  assert.equal((await host(path + "/prepare", {})).status, 200);
  match = (await view()).match!;
  assert.equal((await host(path + "/match/" + match.id + "/prepare", {})).status, 202);
  await eventually(view, (state) => state.match?.stage === "ready");
  for (const browser of [host, guest])
    assert.equal(
      (await browser(path + "/player", { car: "Orbital", compatibility, ready: true })).status,
      200,
    );
  assert.equal((await host(path + "/start", {})).status, 200);
  await eventually(view, (state) => state.match?.stage === "playing");
  assert.equal((await stranger(path + "/join", { playerName: "Pending outage" })).status, 200);
  assert.equal(
    (await stranger(path + "/player", { car: "Orbital", compatibility, ready: false })).status,
    200,
  );
  assert.equal(
    (await stranger(path + "/player", { car: "Orbital", compatibility, ready: true })).status,
    200,
  );
  const lookupUnavailableServer = server();
  await lookupUnavailableServer.cancelAdmissionsForTest();
  await lookupUnavailableServer.configureForTest({ lookupFailure: true });
  const failedLookup = (await room.checkMatchForTest())!;
  const failedLookupDeadline = failedLookup.monitoringUnavailableUntil;
  assert(failedLookupDeadline !== null && failedLookupDeadline > Date.now());
  await room.restoreMatchFromStorageForTest();
  await Bun.sleep(30);
  assert.equal((await room.checkMatchForTest())!.monitoringUnavailableUntil, failedLookupDeadline);
  assert.equal((await lookupUnavailableServer.inspectForTest()).stops, 0);
  assert.equal((await directory.reservationForTest(initial.id))?.session, match.id);
  await eventually(view, (state) => state.match === null, monitoringGrace + 5000);
  assert.equal((await lookupUnavailableServer.inspectForTest()).stops, 1);
  assert.equal(await directory.reservationForTest(initial.id), undefined);
  assert.equal((await stranger(path + "/leave", {})).status, 200);
  console.log(
    "PASS partial membership-monitoring outage keeps its persisted deadline and expires with bounded cleanup",
  );
  assert.equal((await host(path + "/prepare", {})).status, 200);
  match = (await view()).match!;
  const emptyServer = server();
  await room.emptyMatchForTest();
  await eventually(view, (state) => state.match === null);
  assert.equal((await emptyServer.inspectForTest()).stops, 1);
  const reservations = Array.from({ length: 10 }, (_, index) => ({
    room: "quota-" + index,
    session: crypto.randomUUID(),
  }));
  for (const lease of reservations) assert(await directory.reserveMatch(lease.room, lease.session));
  assert.equal(await directory.reserveMatch("over-capacity", "next"), false);
  assert.equal(await directory.reserveMatch(reservations[0]!.room, "stale-session"), false);
  await directory.releaseMatch(reservations[0]!.room, "stale-session");
  assert.equal(await directory.reserveMatch("over-capacity", "next"), false);
  for (const lease of reservations) await directory.releaseMatch(lease.room, lease.session);
  assert(await directory.reserveMatch("over-capacity", "next"));
  await directory.releaseMatch("over-capacity", "next");
  console.log(
    "PASS room match authority: scoped setup, fixed roster/start race, native results return, stop retries, upload failure, timeout and fresh session",
  );
} finally {
  for (const socket of sockets) socket.close();
  await mf.dispose();
}
