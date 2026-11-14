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
  test("car and resources changes require separate readiness confirmation", () => {
    const state = fixture();
    expect(() =>
      updatePlayer(state, "guest", { ...selected, car: "Pizza Boy", ready: true }),
    ).toThrow();
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
