import { expect, test } from "bun:test";

import { createRoomsClient, RoomsApiError } from "@tm4/rooms-client";
import type { MatchSnapshot, RoomSnapshot } from "@tm4/rooms-client/schemas";

import {
  createRoomStore,
  roomCarChoices,
  roomSelectedCar,
} from "../../apps/rustymetal4.com/src/state/room.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const id = "a".repeat(32);
const host = "9bad46c2-542d-4d6e-a78a-2ec81a700a23";
const compatibility = { protocol: 15, build: "b".repeat(64), content: "c".repeat(64) };
const disc = { compatibility, cars: ["Calypso", "Quatro"] };
const match: MatchSnapshot = {
  id: "74433021-24b5-43fe-b1b9-eb16565b6092",
  stage: "ready",
  deadline: 0,
  cars: [...disc.cars],
  message: "Ready",
  endpoint: null,
  credential: null,
};
function snapshot(version = 1): RoomSnapshot {
  return {
    id,
    name: "Test room",
    modeId: "ffa",
    mapId: "neon-city",
    capacity: 8,
    host: "Host",
    hostId: host,
    you: host,
    version,
    participantCount: 1,
    freePlaces: 7,
    participants: [
      { id: host, name: "Host", connected: true, car: "Calypso", ready: false, loaded: true },
    ],
    match: null,
    journal: null,
    notice: "",
    emptyUntil: null,
    closed: false,
  };
}
function setup() {
  const api = createRoomsClient({
    baseURL: "https://example.test/api/",
    fetch: () => {
      throw new Error("Unexpected API call");
    },
  });
  const store = createRoomStore(id, api, () => Promise.resolve());
  store.getState().receive(snapshot());
  store.setState({ disc });
  return { api, store };
}
async function settled(store: ReturnType<typeof createRoomStore>) {
  for (let i = 0; i < 20 && store.getState().operation; i++) await Promise.resolve();
  expect(store.getState().operation).toBeNull();
}

test("old HTTP snapshots cannot replace newer live room state or a settings draft", () => {
  const { store } = setup();
  const draft = { name: "Draft", modeId: "ffa", mapId: "road-rage" };
  store.getState().editSettings(draft);
  store.getState().receive({ ...snapshot(3), name: "Newest" });
  store.getState().receive({ ...snapshot(2), name: "Old response" });
  expect(store.getState().room?.name).toBe("Newest");
  expect(store.getState().settingsDraft).toBe(draft);
  store.getState().receive({ ...snapshot(4), hostId: null });
  expect(store.getState().settingsDraft).toBeNull();
});

test("settings errors and unsaved edits survive live updates, retry uses the latest draft", async () => {
  const { api, store } = setup();
  store.getState().editSettings({ name: "Draft", modeId: "ffa", mapId: "neon-city" });
  api.settings = () => Promise.reject(new Error("Try again"));
  await store.getState().saveSettings();
  store.getState().receive(snapshot(2));
  expect(store.getState().errors.settings).toBe("Try again");
  expect(store.getState().settingsDraft?.name).toBe("Draft");
  const response = deferred<RoomSnapshot>();
  api.settings = async (_id, input) => {
    expect(input.name).toBe("Draft");
    return response.promise;
  };
  const saving = store.getState().saveSettings();
  store.getState().editSettings({ name: "New draft", modeId: "ffa", mapId: "road-rage" });
  response.resolve({ ...snapshot(3), name: "Draft" });
  await saving;
  expect(store.getState().settingsDraft?.name).toBe("New draft");
  expect(store.getState().settingsSaved).toBe(false);
});

test("a pending car selection stays visible across broadcasts and rolls back on rejection", async () => {
  const { api, store } = setup();
  const response = deferred<RoomSnapshot>();
  let requests = 0;
  api.player = async (_id, input) => {
    requests++;
    expect(input.car).toBe("Quatro");
    return response.promise;
  };
  const selecting = store.getState().selectCar("Quatro");
  expect(store.getState().operation).toBe("player");
  store.getState().receive(snapshot(2));
  expect(roomSelectedCar(store.getState())).toBe("Quatro");
  await store.getState().selectCar("Calypso");
  await store.getState().toggleReady();
  expect(requests).toBe(1);
  response.reject(new Error("Car not available"));
  await selecting;
  expect(roomSelectedCar(store.getState())).toBe("Calypso");
  store.getState().playerReported("Player is running");
  store.getState().receive(snapshot(3));
  expect(store.getState().errors.player).toBe("Car not available");
});

test("a successful selection follows the latest authority and Ready uses that car", async () => {
  const { api, store } = setup();
  const response = deferred<RoomSnapshot>();
  api.player = () => response.promise;
  const selecting = store.getState().selectCar("Quatro");
  const accepted = snapshot(3);
  accepted.participants[0]!.car = "Quatro";
  store.getState().receive(accepted);
  response.resolve(snapshot(2));
  await selecting;
  expect(store.getState().room?.version).toBe(3);
  expect(roomSelectedCar(store.getState())).toBe("Quatro");
  api.player = (_id, input) => {
    expect(input).toEqual({ car: "Quatro", compatibility, ready: true });
    return Promise.resolve({ ...accepted, version: 4 });
  };
  await store.getState().toggleReady();
});

test("loading a disc during an operation publishes the latest resources afterwards", async () => {
  const { api, store } = setup();
  const response = deferred<RoomSnapshot>();
  api.settings = () => response.promise;
  const saving = store.getState().saveSettings();
  const loaded = { compatibility: { ...compatibility, content: "d".repeat(64) }, cars: ["Quatro"] };
  let published = 0;
  api.player = (_id, input) => {
    published++;
    expect(input).toEqual({ car: "Quatro", compatibility: loaded.compatibility, ready: false });
    return Promise.resolve({
      ...snapshot(3),
      participants: [{ ...snapshot().participants[0]!, car: "Quatro" }],
    });
  };
  store.getState().playerLoaded(null);
  store.getState().playerLoaded(loaded);
  expect(published).toBe(0);
  response.resolve(snapshot(2));
  await saving;
  await settled(store);
  expect(published).toBe(1);
  expect(store.getState().disc).toBe(loaded);
  expect(store.getState().playerNeedsSync).toBe(false);
});

test("late joining offers only prepared cars and loading a running session does not reset Ready", async () => {
  const { api, store } = setup();
  store
    .getState()
    .receive({ ...snapshot(2), match: { ...match, stage: "playing", cars: ["Quatro"] } });
  expect(roomCarChoices(store.getState())).toEqual(["Quatro"]);
  expect(roomSelectedCar(store.getState())).toBe("Quatro");
  api.player = () => {
    throw new Error("Must not reset a running session");
  };
  store.getState().receive({
    ...snapshot(3),
    match: { ...match, stage: "playing", endpoint: "/socket", credential: "d".repeat(64) },
  });
  store.getState().playerLoaded(disc);
  await settled(store);
  expect(store.getState().errors.player).toBeNull();
  expect(store.getState().playerNeedsSync).toBe(false);
});

test("temporary recovery failures retain room state; expiry cannot be undone by a late response", async () => {
  const { api, store } = setup();
  store.getState().loadFailed(new RoomsApiError(503, "Temporary failure"));
  expect(store.getState().connection).toBe("reconnecting");
  expect(store.getState().disc).toBe(disc);
  store.getState().receive(snapshot(2));
  store.getState().connectionChanged(true);
  expect(store.getState().connection).toBe("live");
  expect(store.getState().errors.room).toBeNull();
  const response = deferred<RoomSnapshot>();
  api.player = () => response.promise;
  const selecting = store.getState().selectCar("Quatro");
  store.getState().loadFailed(new RoomsApiError(410, "Expired"));
  response.resolve(snapshot(5));
  await selecting;
  store.getState().receive(snapshot(6));
  store.getState().connectionChanged(true);
  expect(store.getState().connection).toBe("expired");
  expect(store.getState().room).toBeNull();
  expect(store.getState().disc).toBeNull();
});

test("losing membership while choosing a car cannot resurrect the old player", async () => {
  const { api, store } = setup();
  const response = deferred<RoomSnapshot>();
  api.player = () => response.promise;
  const selecting = store.getState().selectCar("Quatro");
  store.getState().receive({ ...snapshot(3), you: null });
  response.resolve(snapshot(4));
  await selecting;
  expect(store.getState().room?.you).toBeNull();
  expect(store.getState().disc).toBeNull();
  expect(store.getState().carDraft).toBeUndefined();
});

test("leave completes even if its live event arrives before the HTTP response", async () => {
  const { api, store } = setup();
  const response = deferred<RoomSnapshot>();
  api.leave = () => response.promise;
  const leaving = store.getState().leave();
  const left = { ...snapshot(2), you: null };
  store.getState().receive(left);
  response.resolve(left);
  expect(await leaving).toBe(true);
  store.getState().receive(snapshot(3));
  expect(store.getState().departed).toBe(true);
  expect(store.getState().room?.you).toBeNull();
});

test("failed leave retains membership and allows retry", async () => {
  const { api, store } = setup();
  api.leave = () => Promise.reject(new Error("Unavailable"));
  expect(await store.getState().leave()).toBe(false);
  expect(store.getState().departed).toBe(false);
  expect(store.getState().room?.you).toBe(host);
  expect(store.getState().operation).toBeNull();
  api.leave = () => Promise.resolve({ ...snapshot(2), you: null });
  expect(await store.getState().leave()).toBe(true);
});

test("journal downloading is independent of room operations and cannot be duplicated", async () => {
  const { api, store } = setup();
  store.getState().receive({ ...snapshot(2), match });
  const response = deferred<Awaited<ReturnType<typeof api.journal>>>();
  let requests = 0;
  api.journal = () => {
    requests++;
    return response.promise;
  };
  const download = store.getState().downloadJournal();
  expect(store.getState().journal.downloading).toBe(true);
  expect(store.getState().operation).toBeNull();
  expect(await store.getState().downloadJournal()).toBeNull();
  response.reject(new Error("Journal not ready"));
  expect(await download).toBeNull();
  expect(requests).toBe(1);
  expect(store.getState().journal).toEqual({ downloading: false, message: "Journal not ready" });
  api.journal = () => Promise.resolve({ bytes: new Blob(["journal"]), savedAt: 1000 });
  expect((await store.getState().downloadJournal())?.matchId).toBe(match.id);
});
