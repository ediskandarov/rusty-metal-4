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
  resetMatch,
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
