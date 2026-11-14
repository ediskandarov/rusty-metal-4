import { describe, expect, test } from "bun:test";

import { roomSettingsSchema } from "@tm4/rooms-client/schemas";

import { readJson } from "../../apps/rustymetal4.com/src/http.ts";
import {
  connect,
  createState,
  disconnect,
  edit,
  emptyGrace,
  join,
  nextDeadline,
  prune,
  reconnectGrace,
  removeMember,
  settings,
  snapshot,
  summary,
} from "../../apps/rustymetal4.com/src/room-state.ts";

const options = {
  name: "Wrecking crew",
  modeId: "ffa",
  mapId: "construction-yard",
  capacity: 8,
  playerName: "Host",
};
const make = () => {
  const state = createState(
    "public-id",
    "private-host-key",
    { name: options.name, playerName: options.playerName },
    1000,
  );
  edit(state, "private-host-key", options);
  return state;
};

describe("authoritative room transitions", () => {
  test("creation needs only names and establishes server-owned defaults", () => {
    const state = createState(
      "public-id",
      "private-host-key",
      { name: "New room", playerName: "Host" },
      1000,
    );
    expect(state.settings).toEqual({
      name: "New room",
      modeId: "ffa",
      mapId: "construction-yard",
      capacity: 8,
    });
    expect(summary(state).freePlaces).toBe(7);
    for (const invalid of [
      { name: "", playerName: "Host" },
      { name: "New room", playerName: "" },
    ])
      expect(() => createState("id", "key", invalid, 1000)).toThrow();
  });
  test("creator occupies the first slot and public data never exposes credentials", () => {
    const state = make();
    expect(state.members).toHaveLength(1);
    expect(state.hostId).toBe(state.members[0]!.id);
    const publicData = JSON.stringify([summary(state), snapshot(state, "")]);
    expect(publicData).not.toContain("private-host-key");
    expect(snapshot(state, "private-host-key").you).toBe(state.hostId);
    expect(snapshot(state, "").you).toBeNull();
  });
  test("joining twice preserves the same identity and capacity is authoritative", () => {
    const state = make();
    const guest = join(state, "guest", "Guest", 1000);
    expect(join(state, "guest", "Other name", 2000).id).toBe(guest.id);
    expect(state.members).toHaveLength(2);
    join(state, "third", "Third", 1000);
    expect(summary(state).freePlaces).toBe(5);
    for (let place = 4; place <= 8; place++) join(state, `guest-${place}`, `Guest ${place}`, 1000);
    expect(state.members).toHaveLength(8);
    expect(() => join(state, "ninth", "Ninth", 1000)).toThrow("full");
    expect(join(state, "guest", "Guest", 2000).id).toBe(guest.id);
    expect(summary(state).freePlaces).toBe(0);
  });
  test("only the host can edit and FFA capacity cannot be configured", () => {
    const state = make();
    expect(() => edit(state, "unknown", options)).toThrow("Only the host");
    edit(state, "private-host-key", { ...options, name: "New name" });
    join(state, "one", "One", 1000);
    join(state, "two", "Two", 1000);
    for (const capacity of [1, 2, 3, 4, 5, 6, 7, 9, 2.5, "8", undefined]) {
      const invalid = { ...options, capacity };
      expect(() => edit(state, "private-host-key", invalid)).toThrow("eight player places");
      expect(roomSettingsSchema.safeParse(invalid).success).toBe(false);
    }
    expect(state.settings.capacity).toBe(8);
    expect(state.settings.name).toBe("New name");
    for (const invalid of [{ modeId: "racing" }, { mapId: "unknown" }, { name: "\n" }])
      expect(() => settings({ ...options, ...invalid })).toThrow();
  });
  test("tabs, reconnects and stale socket callbacks cannot evict a live member", () => {
    const state = make();
    const host = connect(state, "private-host-key", "old");
    connect(state, "private-host-key", "other-tab");
    disconnect(state, host.id, "old", 2000);
    expect(host.disconnectedUntil).toBeNull();
    disconnect(state, host.id, "other-tab", 3000);
    expect(host.disconnectedUntil).toBe(3000 + reconnectGrace);
    connect(state, "private-host-key", "new");
    expect(disconnect(state, host.id, "old", 5000)).toBe(false);
    prune(state, 3000 + reconnectGrace);
    expect(state.members).toHaveLength(1);
    expect(host.connections).toEqual(["new"]);
    for (const id of ["2", "3", "4"]) connect(state, "private-host-key", id);
    expect(() => connect(state, "private-host-key", "5")).toThrow("too many tabs");
  });
  test("definitive disconnect transfers host and an empty room closes after its persisted grace", () => {
    const state = make();
    join(state, "guest", "Guest", 2000);
    connect(state, "guest", "guest-socket");
    expect(prune(state, 1000 + reconnectGrace - 1)).toBe(false);
    prune(state, 1000 + reconnectGrace);
    expect(state.hostId).toBe(state.members[0]!.id);
    expect(state.members[0]!.name).toBe("Guest");
    removeMember(state, state.hostId!, 50_000);
    expect(state.emptyUntil).toBe(50_000 + emptyGrace);
    state.publishAt = 0;
    expect(nextDeadline(state)).toBe(50_000 + emptyGrace);
    prune(state, 50_000 + emptyGrace - 1);
    expect(state.closed).toBe(false);
    prune(state, 50_000 + emptyGrace);
    expect(state.closed).toBe(true);
    expect(() => join(state, "late", "Late", 99_000)).toThrow("closed");
  });
  test("closing waits for its future directory retry, ignoring the expired empty deadline", () => {
    const state = make();
    removeMember(state, state.hostId!, 1000);
    prune(state, 1000 + emptyGrace);
    state.publishAt = 1000 + emptyGrace + 5000;
    expect(nextDeadline(state)).toBe(state.publishAt);
  });
  test("returning during empty grace invalidates the old cleanup deadline", () => {
    const state = make();
    removeMember(state, state.hostId!, 1000);
    const guest = join(state, "new", "New host", 2000);
    connect(state, "new", "socket");
    prune(state, 1000 + emptyGrace);
    expect(state.closed).toBe(false);
    expect(state.emptyUntil).toBeNull();
    expect(state.hostId).toBe(guest.id);
  });
  test("request size is bounded even without Content-Length", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(2049)));
        controller.close();
      },
    });
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    await expect(readJson(request)).rejects.toThrow("too large");
    await expect(
      readJson(
        new Request("https://example.test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
      ),
    ).rejects.toThrow("Invalid JSON");
  });
});
