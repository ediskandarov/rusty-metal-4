import { expect, test } from "bun:test";

import { createRoomsClient, RoomsApiError } from "@tm4/rooms-client";
import type { MatchSnapshot, RoomSnapshot } from "@tm4/rooms-client/schemas";

import { tournamentSelectionStatus } from "../../apps/rustymetal4.com/src/modes/tournament/status.ts";
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
const compatibility = { protocol: 16, build: "b".repeat(64), content: "c".repeat(64) };
const disc = { compatibility, cars: ["Calypso", "Quatro"] };
const match: MatchSnapshot = {
  location: null,
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

test("another room tab cannot strand this tab's retained disc and selection between matches", async () => {
  const { api, store } = setup();
  const selected = snapshot(2);
  selected.participants[0]!.car = "Quatro";
  store.getState().receive(selected);
  let published = 0;
  api.player = (_id, input) => {
    published++;
    expect(input).toEqual({ car: "Quatro", compatibility, ready: false });
    return Promise.resolve({ ...selected, version: 4 });
  };
  const unloaded = snapshot(3);
  unloaded.participants[0]!.loaded = false;
  unloaded.participants[0]!.car = null;
  store.getState().receive(unloaded);
  await settled(store);
  expect(published).toBe(1);
  expect(store.getState().disc).toBe(disc);
  expect(roomSelectedCar(store.getState())).toBe("Quatro");
  expect(store.getState().room?.participants[0]!.loaded).toBe(true);
});

test("engine confirmation received during a player request is sent after it completes", async () => {
  const { api, store } = setup();
  const tournament = {
    ...snapshot(2),
    modeId: "tournament" as const,
    capacity: 2 as const,
    mapId: "construction-yard" as const,
  };
  store.setState({ room: tournament });
  const first = deferred<RoomSnapshot>();
  const inputs: unknown[] = [];
  api.player = async (_id, input) => {
    inputs.push(input);
    if (inputs.length === 1) return first.promise;
    return {
      ...tournament,
      version: 4,
      participants: tournament.participants.map((p) => ({
        ...p,
        car: input.car,
        ready: input.ready,
      })),
    };
  };
  store.getState().playerLoaded(disc);
  await store.getState().engineCarSelected("Quatro");
  expect(inputs).toHaveLength(1);
  first.resolve({ ...tournament, version: 3 });
  await settled(store);
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toEqual({ car: "Quatro", compatibility, ready: true });
  await store.getState().engineCarSelected(null);
  expect(inputs[2]).toEqual({ car: null, compatibility, ready: false });
});

test("changing from tournament to FFA publishes a new choice without carrying readiness", async () => {
  const { api, store } = setup();
  store.setState({
    room: { ...snapshot(2), modeId: "tournament", capacity: 2 },
    tournamentChoice: { car: "Quatro" },
  });
  const next = snapshot(3);
  next.participants[0]!.car = null;
  const inputs: unknown[] = [];
  api.player = (_id, input) => {
    inputs.push(input);
    return Promise.resolve({
      ...next,
      version: 4,
      participants: next.participants.map((p) => ({ ...p, car: input.car, ready: input.ready })),
    });
  };
  store.getState().receive(next);
  await settled(store);
  expect(inputs).toEqual([{ car: "Calypso", compatibility, ready: false }]);
  expect(store.getState().tournamentChoice).toBeNull();
});

test("a refreshed tournament snapshot stops the previous match before opening car selection", async () => {
  const { roomMatch } = await import("../../apps/rustymetal4.com/src/room-match.ts");
  const { store } = setup();
  const messages: { action: string; enabled?: boolean; sessionId?: string }[] = [];
  class Element {
    hidden = false;
    options: { value: string }[] = [];
    contentWindow = { postMessage: (message: (typeof messages)[number]) => messages.push(message) };
    hasAttribute() {
      return true;
    }
    closest() {
      return this;
    }
    replaceChildren(...options: { value: string }[]) {
      this.options = options;
    }
  }
  const elements = new Map<string, Element>();
  const globals = {
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
    },
    window: { addEventListener() {}, removeEventListener() {} },
    location: { origin: "https://example.test", href: "https://example.test/rooms/" + id },
    Option: class {
      constructor(
        public text: string,
        public value: string,
      ) {}
    },
    fetch: () => new Promise<Response>(() => {}),
  };
  const originals = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  let dispose: (() => void) | undefined;
  try {
    Object.assign(globalThis, globals);
    store.getState().receive({
      ...snapshot(10),
      match: { ...match, stage: "playing", endpoint: "/match/socket", credential: "credential" },
    });
    store.setState({ operation: "settings", runtime: "available" });
    dispose = roomMatch(id, store);
    expect(messages.at(-1)?.action).toBe("join");
    messages.length = 0;
    // Version 11 ended the FFA match while this client was disconnected.
    store.getState().receive({ ...snapshot(12), modeId: "tournament", capacity: 2 });
    expect(messages.map(({ action }) => action)).toEqual([
      "stop",
      "car-selection",
      "car-selection-status",
    ]);
    expect(messages[0]?.sessionId).toBe(match.id);
    expect(messages[1]?.enabled).toBe(true);
    store.setState({ playerStatus: "Refreshed" });
    expect(messages).toHaveLength(3);
  } finally {
    dispose?.();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("tournament waiting status follows confirmed room state rather than local Done", () => {
  const { store } = setup();
  const current: RoomSnapshot = { ...snapshot(10), modeId: "tournament", capacity: 2 };
  store.setState({ room: current, connection: "live", playerNeedsSync: false });
  expect(tournamentSelectionStatus(store.getState()).phase).toBe("choosing");
  store.setState({ tournamentChoice: { car: "Calypso" }, operation: "player" });
  expect(tournamentSelectionStatus(store.getState()).phase).toBe("confirming");
  store.setState({ operation: null });
  expect(tournamentSelectionStatus(store.getState()).phase).toBe("choosing");
  current.participants[0]!.ready = true;
  store.getState().receive({ ...current, version: 11 });
  expect(tournamentSelectionStatus(store.getState()).message).toContain("second player to join");
  const guest = { ...current.participants[0]!, id: "guest", name: "Guest", ready: false };
  store
    .getState()
    .receive({ ...current, version: 12, participants: [...current.participants, guest] });
  expect(tournamentSelectionStatus(store.getState()).message).toContain("Guest to choose");
  store.getState().receive({
    ...current,
    version: 13,
    participants: [...current.participants, { ...guest, ready: true }],
  });
  expect(tournamentSelectionStatus(store.getState()).phase).toBe("ready");
  store.setState({ connection: "reconnecting" });
  expect(tournamentSelectionStatus(store.getState()).phase).toBe("reconnecting");
  store.setState({ connection: "live" });
  store.getState().receive({
    ...current,
    version: 14,
    participants: [...current.participants, { ...guest, connected: false }],
  });
  expect(tournamentSelectionStatus(store.getState()).message).toContain("Guest to reconnect");
  store.setState({ errors: { ...store.getState().errors, player: "Resources differ" } });
  expect(tournamentSelectionStatus(store.getState())).toMatchObject({
    phase: "error",
    title: "Your choice was not confirmed",
  });
  expect(tournamentSelectionStatus(store.getState()).message).toContain("Done to retry");
});
