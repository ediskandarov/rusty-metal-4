import { describe, expect, test } from "bun:test";

import { networkProtocolVersion } from "@tm4/lightyear-client/schemas";

import {
  beginPreparation,
  connect,
  createState,
  disconnect,
  edit,
  freezeRoster,
  join,
  removeMember,
  resetMatch,
  retainResult,
  snapshot,
  updatePlayer,
} from "../../apps/rustymetal4.com/src/room-state.ts";

const compatibility = {
  protocol: networkProtocolVersion,
  build: "a".repeat(64),
  content: "b".repeat(64),
};
const selected = { car: "Orbital", compatibility, ready: false };
function fixture() {
  const state = createState("room", "host", { name: "Crew", playerName: "Host" }, 100);
  join(state, "guest", "Guest", 100);
  connect(state, "host", "host-tab");
  connect(state, "guest", "guest-tab");
  for (const key of ["host", "guest"]) updatePlayer(state, key, selected);
  const match = beginPreparation(state, "host", 100);
  match.compatibility = compatibility;
  match.cars = ["Orbital", "Pizza Boy"];
  match.stage = "ready";
  for (const key of ["host", "guest"]) updatePlayer(state, key, { ...selected, ready: true });
  return state;
}
describe("room match authority", () => {
  test("eight places allow a two-participant start and later admission", () => {
    const state = fixture();
    expect(state.settings.capacity).toBe(8);
    const match = freezeRoster(state, "host", 200);
    expect(match.roster).toHaveLength(2);
    expect(() => join(state, "late", "Late", 200)).toThrow("still preparing");
    expect(join(state, "host", "Host", 200).id).toBe(match.roster[0]!.id);
    expect(() => updatePlayer(state, "host", selected)).toThrow("locked");
    expect(() => freezeRoster(state, "host", 200)).toThrow();
    match.stage = "playing";
    join(state, "third", "Third", 300);
    expect(snapshot(state, "third").capacity).toBe(8);
    expect(snapshot(state, "third").freePlaces).toBe(5);
    expect(match.roster).toHaveLength(2);
  });
  test("Done atomically confirms a prepared car; incompatible resources are rejected", () => {
    const state = fixture();
    updatePlayer(state, "guest", { ...selected, car: "Pizza Boy", ready: true });
    expect(state.members[1]!.car).toBe("Pizza Boy");
    expect(state.members[1]!.ready).toBe(true);
    updatePlayer(state, "guest", { ...selected, car: "Pizza Boy" });
    expect(() => freezeRoster(state, "host", 200)).toThrow("every participant ready");
    updatePlayer(state, "guest", { ...selected, car: "Pizza Boy", ready: true });
    expect(() =>
      updatePlayer(state, "guest", {
        ...selected,
        compatibility: { ...compatibility, content: "c".repeat(64) },
        ready: true,
      }),
    ).toThrow();
  });
  test("only host starts; disconnect invalidates readiness without evicting another tab", () => {
    const state = fixture();
    expect(() => freezeRoster(state, "guest", 200)).toThrow("Only the host");
    connect(state, "guest", "second");
    const guest = state.members[1]!;
    disconnect(state, guest.id, "guest-tab", 200);
    expect(guest.ready).toBe(true);
    disconnect(state, guest.id, "second", 200);
    expect(guest.ready).toBe(false);
    expect(() => freezeRoster(state, "host", 200)).toThrow();
  });
  test("completion retains room settings and members, resets readiness and scopes credentials", () => {
    const state = fixture();
    const match = freezeRoster(state, "host", 200);
    const host = snapshot(state, "host"),
      guest = snapshot(state, "guest"),
      stranger = snapshot(state, "stranger");
    expect(host.match!.credential).not.toBe(guest.match!.credential);
    expect(stranger.match!.credential).toBeNull();
    expect(stranger.match!.endpoint).toBeNull();
    resetMatch(state, "Finished", 300);
    expect(state.id).toBe("room");
    expect(state.members).toHaveLength(2);
    expect(state.members.every((member) => !member.ready)).toBe(true);
    expect(state.settings.mapId).toBe("construction-yard");
    const next = beginPreparation(state, "host", 400);
    expect(next.id).not.toBe(match.id);
  });
  test("settings invalidate readiness and cannot race preparation", () => {
    const state = fixture();
    expect(() => edit(state, "host", state.settings)).toThrow("Cancel preparation");
    resetMatch(state, "Cancelled", 300);
    state.members[0]!.ready = true;
    edit(state, "host", { ...state.settings, mapId: "neon-city" });
    expect(state.members[0]!.ready).toBe(false);
  });
});

test("running membership advertises vacancies and limits late car selection to the prepared pool", () => {
  const state = fixture();
  const match = freezeRoster(state, "host", 200);
  expect(match.cars).toEqual(["Orbital", "Pizza Boy"]);
  match.stage = "playing";
  const late = join(state, "late", "Late", 300);
  connect(state, "late", "late-tab");
  expect(snapshot(state, "late").freePlaces).toBe(5);
  expect(snapshot(state, "late").match!.endpoint).toBeNull();
  updatePlayer(state, "late", selected);
  expect(() => updatePlayer(state, "late", { ...selected, car: "Crusher", ready: true })).toThrow();
  updatePlayer(state, "late", { ...selected, ready: true });
  expect(late.ready).toBe(true);
  expect(match.roster).toHaveLength(2);
  expect(() => updatePlayer(state, "host", selected)).toThrow("locked");
});

test("authoritative sparse identities preserve names and ties after teardown and reconnect", () => {
  const state = fixture();
  const match = freezeRoster(state, "host", 200);
  match.stage = "playing";
  const oldGuest = state.members[1]!;
  const result = {
    sessionId: match.id,
    completion: { tick: 600, reasons: 3, winners: 129 },
    participants: [
      {
        identity: { participant: "0000000000000009", slot: 7 },
        credential: match.roster[1]!.credential,
        score: { frags: 20, deaths: 12 },
      },
      {
        identity: { participant: "0000000000000001", slot: 0 },
        credential: match.roster[0]!.credential,
        score: { frags: 20, deaths: 0 },
      },
    ],
  };
  // A room leave can race the ending tick. Its name receipt survives without awarding a replacement.
  state.members.splice(1, 1);
  match.roster.splice(1, 1);
  join(state, "replacement", "Replacement", 250);
  expect(retainResult(state, match.id, result)).toBe(true);
  expect(
    state.result!.participants.map((row) => [row.name, row.identity.slot, row.winner]),
  ).toEqual([
    ["Guest", 7, true],
    ["Host", 0, true],
  ]);
  expect(state.result!.participants[0]!.memberId).toBe(oldGuest.id);
  const saved = structuredClone(state.result);
  expect(retainResult(state, match.id, { ...result, participants: [] })).toBe(true);
  expect(state.result).toEqual(saved);
  resetMatch(state, "Finished", 300);
  expect(snapshot(state, "host").result).toEqual(saved);
  disconnect(state, state.members[0]!.id, "host-tab", 320);
  connect(state, "host", "new-tab");
  expect(snapshot(state, "host").result).toEqual(saved);
  const next = beginPreparation(state, "host", 400);
  expect(snapshot(state, "host").result).toEqual(saved);
  expect(retainResult(state, match.id, result)).toBe(false);
  resetMatch(state, "Preparation failed", 450);
  expect(state.result).toEqual(saved);
  const retry = beginPreparation(state, "host", 500);
  retry.stage = "ready";
  retry.compatibility = compatibility;
  retry.cars = ["Orbital"];
  connect(state, "replacement", "replacement-tab");
  for (const key of ["host", "replacement"]) {
    updatePlayer(state, key, selected);
    updatePlayer(state, key, { ...selected, ready: true });
  }
  const started = freezeRoster(state, "host", 550);
  expect(started.id).not.toBe(next.id);
  expect(state.result).toBeUndefined();
  expect(retainResult(state, match.id, result)).toBe(false);
  expect(snapshot(state, "host").result).toBeNull();
});

test("a new host can prepare while the previous host remains named in the last result", () => {
  const state = fixture();
  const match = freezeRoster(state, "host", 200);
  retainResult(state, match.id, {
    sessionId: match.id,
    completion: { tick: 600, reasons: 1, winners: 3 },
    participants: match.roster.map((entry, slot) => ({
      identity: { participant: (slot + 1).toString(16).padStart(16, "0"), slot },
      credential: entry.credential,
      score: { frags: 0, deaths: 0 },
    })),
  });
  resetMatch(state, "Finished", 300);
  const result = structuredClone(state.result);
  removeMember(state, state.hostId!, 350);
  expect(state.hostId).toBe(state.members[0]!.id);
  beginPreparation(state, "guest", 400);
  expect(snapshot(state, "guest").result).toEqual(result);
  expect(state.result!.participants[0]!.name).toBe("Host");
});

test("a ready host can start alone and keep seven places for late entrants", () => {
  const state = fixture();
  removeMember(state, state.members[1]!.id, 150);
  updatePlayer(state, "host", { ...selected, ready: true });
  const match = freezeRoster(state, "host", 200);
  expect(match.roster).toHaveLength(1);
  expect(state.settings.capacity).toBe(8);
  match.stage = "playing";
  expect(snapshot(state, "host").freePlaces).toBe(7);
  join(state, "late", "Late", 300);
  expect(snapshot(state, "late").freePlaces).toBe(6);
});

test("FFA quotas allow late humans alongside bots and retain named results", () => {
  const state = fixture();
  state.match = null;
  edit(state, "host", {
    ...state.settings,
    modeOptions: { ffa: { bots: ["Pizza Boy", "Orbital"], humanLimit: 4 } },
  });
  expect(snapshot(state, "host").participantCount).toBe(4);
  expect(snapshot(state, "host").freePlaces).toBe(2);
  const match = beginPreparation(state, "host", 200);
  match.cars = ["Orbital", "Pizza Boy"];
  match.compatibility = compatibility;
  match.stage = "ready";
  for (const key of ["host", "guest"]) updatePlayer(state, key, { ...selected, ready: true });
  freezeRoster(state, "host", 300);
  expect(match.roster).toHaveLength(2);
  expect(Object.keys(match.botMembers!)).toEqual(["2", "3"]);
  match.stage = "playing";
  expect(snapshot(state, "host").freePlaces).toBe(2);
  const late = join(state, "new", "New", 400);
  join(state, "last", "Last", 400);
  expect(snapshot(state, "host").freePlaces).toBe(0);
  expect(() => join(state, "overflow", "Overflow", 400)).toThrow("full");
  expect(join(state, "new", "New", 400).id).toBe(late.id);
  removeMember(state, late.id, 410);
  expect(snapshot(state, "host").freePlaces).toBe(1);
  const replacement = join(state, "replacement", "Replacement", 420);
  expect(replacement.id).not.toBe(late.id);
  removeMember(state, replacement.id, 430);
  removeMember(state, state.members.find((m) => m.key === "last")!.id, 430);
  expect(join(state, "host", "Host", 400).id).toBe(state.hostId!);
  const result = {
    sessionId: match.id,
    completion: { tick: 600, reasons: 2, winners: 4 },
    participants: [
      {
        identity: { slot: 0, participant: "0000000000000001" },
        credential: match.roster[0]!.credential,
        score: { frags: 1, deaths: 2 },
      },
      {
        identity: { slot: 2, participant: "0000000000000003" },
        credential: null,
        score: { frags: 20, deaths: 1 },
      },
    ],
  };
  expect(retainResult(state, match.id, result)).toBe(true);
  expect(state.result!.participants[1]!.name).toBe("Bot 1");
  expect(state.result!.participants[1]!.winner).toBe(true);
  resetMatch(state, "Finished", 500);
  expect(snapshot(state, "host").freePlaces).toBe(2);
  expect(state.result!.participants[1]!.score.frags).toBe(20);
});

test("bot configuration validates capacity, mode and prepared models without partial changes", () => {
  const state = fixture();
  state.match = null;
  const before = state.settings;
  expect(() =>
    edit(state, "host", {
      ...before,
      modeOptions: { ffa: { bots: Array(7).fill("Orbital"), humanLimit: 2 } },
    }),
  ).toThrow("Invalid mode settings");
  expect(state.settings).toBe(before);
  expect(() =>
    edit(state, "host", { ...before, modeOptions: { ffa: { bots: [], humanLimit: 1 } } }),
  ).toThrow("current room membership");
  expect(state.settings).toBe(before);
  expect(() =>
    edit(state, "guest", { ...before, modeOptions: { ffa: { bots: [], humanLimit: 8 } } }),
  ).toThrow("Only the host");
  expect(() =>
    edit(state, "host", { ...before, modeOptions: { tournament: { bots: [] } } }),
  ).toThrow("Invalid mode settings");
  edit(state, "host", {
    ...before,
    modeOptions: { ffa: { bots: ["Unavailable"], humanLimit: 7 } },
  });
  const match = beginPreparation(state, "host", 200);
  match.cars = ["Orbital"];
  match.compatibility = compatibility;
  match.stage = "ready";
  for (const key of ["host", "guest"]) updatePlayer(state, key, { ...selected, ready: true });
  expect(() => freezeRoster(state, "host", 300)).toThrow("available");
  expect(match.roster).toEqual([]);
  expect(match.stage).toBe("ready");
});

test("finished FFA keeps its mode after the host switches the next match to tournament", () => {
  const state = fixture();
  const match = freezeRoster(state, "host", 200);
  retainResult(state, match.id, {
    sessionId: match.id,
    completion: { tick: 600, reasons: 2, winners: 1 },
    participants: match.roster.map((entry, slot) => ({
      identity: { participant: (slot + 1).toString(16).padStart(16, "0"), slot },
      credential: entry.credential,
      score: { frags: slot === 0 ? 20 : 3, deaths: 1 },
    })),
  });
  expect(state.result?.modeId).toBe("ffa");
  const saved = structuredClone(state.result);
  resetMatch(state, "Finished", 300);
  edit(state, "host", {
    name: "Tournament next",
    modeId: "tournament",
    capacity: 4,
    mapId: "construction-yard",
  });
  expect(snapshot(state, "host").modeId).toBe("tournament");
  expect(snapshot(state, "host").result).toEqual(saved);
});

test("FFA Done survives preparation, unavailable choices are invalidated and Back cancels", async () => {
  const { ffaRules } = await import("../../apps/rustymetal4.com/src/modes/ffa/rules.ts");
  const state = createState("room", "host", { name: "Crew", playerName: "Host" }, 100);
  connect(state, "host", "tab");
  updatePlayer(state, "host", { ...selected, ready: true });
  const match = beginPreparation(state, "host", 100);
  expect(state.members[0]!.ready).toBe(true);
  match.compatibility = compatibility;
  match.cars = ["Orbital"];
  match.stage = "ready";
  ffaRules.serverPrepared(state);
  expect(state.members[0]!.ready).toBe(true);
  updatePlayer(state, "host", { car: null, compatibility, ready: false });
  expect(() => freezeRoster(state, "host", 200)).toThrow("every participant ready");
  expect(() => updatePlayer(state, "host", { ...selected, car: "Pizza Boy", ready: true })).toThrow(
    "prepared server",
  );
  updatePlayer(state, "host", { ...selected, ready: true });
  match.cars = ["Pizza Boy"];
  ffaRules.serverPrepared(state);
  expect(state.members[0]!.ready).toBe(false);
});

test("FFA late admission checks the running server even when the new host has no loaded disc", () => {
  const state = fixture();
  const match = freezeRoster(state, "host", 200);
  match.stage = "playing";
  join(state, "late", "Late", 300);
  state.members[0]!.compatibility = null;
  updatePlayer(state, "late", { ...selected, ready: true });
  expect(state.members[2]!.ready).toBe(true);
});
