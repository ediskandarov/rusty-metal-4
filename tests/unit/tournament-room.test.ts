import { expect, test } from "bun:test";

import { networkProtocolVersion } from "@tm4/lightyear-client/schemas";
import { roomSettingsSchema } from "@tm4/rooms-client/schemas";

import {
  beginPreparation,
  connect,
  createState,
  disconnect,
  edit,
  freezeRoster,
  join,
  snapshot,
  summary,
  updatePlayer,
} from "../../apps/rustymetal4.com/src/room-state.ts";

const options = {
  name: "Tournament",
  modeId: "tournament",
  mapId: "construction-yard",
  capacity: 4,
};
const compatibility = {
  protocol: networkProtocolVersion,
  build: "b".repeat(64),
  content: "c".repeat(64),
};
function room() {
  const state = createState(
    "a".repeat(32),
    "host",
    { name: "Tournament", playerName: "Host" },
    1000,
  );
  edit(state, "host", options);
  connect(state, "host", "host-socket");
  join(state, "guest", "Guest", 1000);
  connect(state, "guest", "guest-socket");
  return state;
}
test("tournament has four human places and no FFA configuration", () => {
  const state = room();
  expect(summary(state).capacity).toBe(4);
  expect(summary(state).freePlaces).toBe(2);
  join(state, "third", "Third", 1000);
  join(state, "fourth", "Fourth", 1000);
  expect(() => join(state, "fifth", "Fifth", 1000)).toThrow("full");
  for (const change of [
    { capacity: 8 },
    { mapId: "road-rage" },
    { modeOptions: { ffa: { bots: [], humanLimit: 2 } } },
  ])
    expect(roomSettingsSchema.safeParse({ ...options, ...change }).success).toBe(false);
});
test("native choices confirm independently, duplicates are allowed, back clears readiness", () => {
  const state = room();
  for (const key of ["host", "guest"])
    updatePlayer(state, key, { car: "Pizza Boy", compatibility, ready: true });
  expect(snapshot(state, "host").participants.every((p) => p.ready && p.car === "Pizza Boy")).toBe(
    true,
  );
  updatePlayer(state, "guest", { car: null, compatibility, ready: false });
  expect(state.members[0]!.ready).toBe(true);
  expect(state.members[1]!.ready).toBe(false);
  expect(state.members[1]!.car).toBeNull();
});
test("missing/mismatched resources cannot confirm and reloading host resources invalidates readiness", () => {
  const state = room();
  updatePlayer(state, "host", { car: "Orbital", compatibility, ready: true });
  for (const invalid of [null, { ...compatibility, content: "d".repeat(64) }])
    expect(() =>
      updatePlayer(state, "guest", { car: "Pizza Boy", compatibility: invalid, ready: true }),
    ).toThrow("matching resources");
  updatePlayer(state, "guest", { car: "Pizza Boy", compatibility, ready: true });
  updatePlayer(state, "host", { car: null, compatibility: null, ready: false });
  expect(state.members.every((member) => !member.ready)).toBe(true);
});
test("reconnect retains identity and car but requires confirmation again", () => {
  const state = room();
  updatePlayer(state, "host", { car: "Orbital", compatibility, ready: true });
  const id = state.members[0]!.id;
  disconnect(state, id, "host-socket", 2000);
  const restored = connect(state, "host", "replacement");
  expect(restored.id).toBe(id);
  expect(restored.car).toBe("Orbital");
  expect(restored.ready).toBe(false);
});
test("tournament preparation preserves Done and start requires two compatible choices", () => {
  const state = room();
  updatePlayer(state, "host", { car: "Orbital", compatibility, ready: true });
  const match = beginPreparation(state, "host", 1000);
  expect(state.members[0]!.ready).toBe(true);
  match.stage = "ready";
  match.compatibility = compatibility;
  match.cars = ["Orbital", "Pizza Boy"];
  expect(() => freezeRoster(state, "host", 1100)).toThrow("ready");
  updatePlayer(state, "guest", { car: "Pizza Boy", compatibility, ready: true });
  freezeRoster(state, "host", 1200);
  expect(match.roster).toHaveLength(2);
  match.stage = "playing";
  expect(() => join(state, "newcomer", "Newcomer", 1300)).toThrow();
});
test("changing mode discards choices and never carries tournament readiness into FFA", () => {
  const state = room();
  updatePlayer(state, "host", { car: "Orbital", compatibility, ready: true });
  edit(state, "host", { ...options, modeId: "ffa", capacity: 8 });
  expect(state.members.every((member) => member.car === null && !member.ready)).toBe(true);
  expect(summary(state).capacity).toBe(8);
});

test("finished tournament keeps its mode after switching the next match to FFA", async () => {
  const { retainResult, resetMatch } = await import("../../apps/rustymetal4.com/src/room-state.ts");
  const state = room();
  for (const key of ["host", "guest"])
    updatePlayer(state, key, { car: "Orbital", compatibility, ready: true });
  const match = beginPreparation(state, "host", 1000);
  Object.assign(match, { stage: "ready", compatibility, cars: ["Orbital"] });
  freezeRoster(state, "host", 1100);
  retainResult(state, match.id, {
    sessionId: match.id,
    completion: { tick: 600, reasons: 4, winners: 3 },
    participants: match.roster.map((entry, slot) => ({
      credential: entry.credential,
      identity: { participant: (slot + 1).toString(16).padStart(16, "0"), slot },
      score: { frags: 2, deaths: 0 },
    })),
  });
  expect(state.result?.modeId).toBe("tournament");
  const saved = structuredClone(state.result);
  resetMatch(state, "Won", 1200);
  edit(state, "host", { ...options, modeId: "ffa", capacity: 8 });
  expect(snapshot(state, "host").modeId).toBe("ffa");
  expect(snapshot(state, "host").result).toEqual(saved);
});

test("four-player tournament waits for every native Done before fixing the roster", () => {
  const state = room();
  for (const key of ["third", "fourth"]) {
    join(state, key, key, 1000);
    connect(state, key, key + "-socket");
  }
  updatePlayer(state, "host", { car: "Orbital", compatibility, ready: true });
  const match = beginPreparation(state, "host", 1000);
  Object.assign(match, { stage: "ready", compatibility, cars: ["Orbital"] });
  for (const key of ["host", "guest", "third"])
    updatePlayer(state, key, { car: "Orbital", compatibility, ready: true });
  expect(() => freezeRoster(state, "host", 1100)).toThrow("ready");
  updatePlayer(state, "fourth", { car: "Orbital", compatibility, ready: true });
  freezeRoster(state, "host", 1200);
  expect(match.roster).toHaveLength(4);
  expect(new Set(match.roster.map((entry) => entry.credential)).size).toBe(4);
});

test("stored room summaries derive capacity from the current mode", () => {
  const state = room();
  Object.assign(state.settings, { capacity: 2 });
  expect(summary(state).capacity).toBe(4);
  expect(summary(state).freePlaces).toBe(2);
});
