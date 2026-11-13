import { expect, test } from "bun:test";

import { createControlsStore } from "../../apps/player/src/state/controls.ts";

function storage(initial: string | null = null) {
  let value = initial;
  let writes = 0;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
      ++writes;
    },
    writes: () => writes,
  };
}

test("keyboard assignment swaps occupied keys without mutating prior snapshots", () => {
  const saved = storage();
  const store = createControlsStore(saved);
  const before = store.getState();
  before.beginCapture("key", 6, 0, 0);
  store.getState().assign("KeyZ");
  expect(store.getState().keyboard[6]).toBe("KeyZ");
  expect(store.getState().keyboard[7]).toBe("KeyX");
  expect(before.keyboard[6]).toBe("KeyX");
  expect(new Set(store.getState().keyboard).size).toBe(16);
  expect(store.getState().capture).toBeNull();
  expect(store.getState().notice).toEqual({
    kind: "assigned",
    target: 6,
    source: "KeyZ",
    previous: 7,
  });
  const restored = createControlsStore(saved).getState();
  expect(restored.keyboard).toEqual(store.getState().keyboard);
  expect(restored.capture).toBeNull();
  expect(restored.player).toBe(0);
  expect(saved.writes()).toBe(1);
});

test("gamepad capture waits for release and rejects simultaneous buttons", () => {
  const saved = storage();
  const store = createControlsStore(saved);
  store.getState().beginCapture("pad", 6, 42, 1 << 6);
  store.getState().sampleGamepad(42, 1 << 6);
  expect(store.getState().capture?.phase).toBe("release");
  store.getState().sampleGamepad(42, 0);
  expect(store.getState().capture?.phase).toBe("press");
  store.getState().sampleGamepad(42, (1 << 5) | (1 << 6));
  expect(store.getState().capture?.phase).toBe("multiple");
  store.getState().sampleGamepad(42, 1 << 5);
  expect(saved.writes()).toBe(0);
  store.getState().sampleGamepad(42, 0);
  store.getState().sampleGamepad(42, 1 << 5);
  expect(store.getState().gamepads[0]![6]).toBe(5);
  expect(store.getState().gamepads[0]![5]).toBe(6);
  expect(saved.writes()).toBe(1);
});

test("controller identity changes cancel capture without changing any mapping", () => {
  const saved = storage();
  const store = createControlsStore(saved);
  const maps = store.getState().gamepads;
  store.getState().beginCapture("pad", 6, 42, 0);
  store.getState().sampleGamepad(43, 1 << 5);
  expect(store.getState().capture).toBeNull();
  expect(store.getState().notice).toEqual({ kind: "disconnected" });
  expect(store.getState().gamepads).toBe(maps);
  expect(saved.writes()).toBe(0);
});

test("player selection isolates mappings and cancels unfinished capture", () => {
  const store = createControlsStore(storage());
  const original = store.getState().gamepads;
  store.getState().beginCapture("key", 6, 0, 0);
  store.getState().selectPlayer(2);
  expect(store.getState().capture).toBeNull();
  store.getState().beginCapture("key", 6, 0, 0);
  expect(store.getState().capture).toBeNull();
  store.getState().beginCapture("pad", 6, 0, 0);
  expect(store.getState().capture).toBeNull();
  store.getState().beginCapture("pad", 6, 42, 0);
  store.getState().sampleGamepad(42, 1 << 5);
  expect(store.getState().gamepads[0]).toBe(original[0]);
  expect(store.getState().gamepads[1]).toBe(original[1]);
  expect(store.getState().gamepads[2]![6]).toBe(5);
  expect(original[2]![6]).toBe(6);
  expect(createControlsStore(storage()).getState().gamepads[2]![6]).toBe(6);
});

test("cancel, invalid keys and invalid indexes do not save preferences", () => {
  const saved = storage();
  const store = createControlsStore(saved);
  store.getState().selectPlayer(4);
  expect(store.getState().player).toBe(0);
  store.getState().beginCapture("key", -1, 0, 0);
  expect(store.getState().capture).toBeNull();
  store.getState().beginCapture("key", 6, 0, 0);
  store.getState().assign("Escape");
  store.getState().assign(5);
  expect(store.getState().capture).not.toBeNull();
  store.getState().cancelCapture();
  store.getState().assign("KeyC");
  expect(store.getState().keyboard[6]).toBe("KeyX");
  expect(saved.writes()).toBe(0);
});

test("malformed stored maps use defaults independently and can be repaired", () => {
  const defaults = createControlsStore(storage()).getState();
  const gamepads = defaults.gamepads.map((map) => [...map]);
  [gamepads[1]![5], gamepads[1]![6]] = [6, 5];
  gamepads[2]![6] = 5;
  const store = createControlsStore(storage(JSON.stringify({ keyboard: ["KeyC"], gamepads })));
  expect(store.getState().keyboard).toEqual(defaults.keyboard);
  expect(store.getState().gamepads[1]![6]).toBe(5);
  expect(store.getState().gamepads[2]).toEqual(defaults.gamepads[2]);
  const broken = storage("{");
  const repaired = createControlsStore(broken);
  expect(repaired.getState().storageAvailable).toBe(true);
  repaired.getState().reset();
  expect(createControlsStore(broken).getState().keyboard).toEqual(defaults.keyboard);
});

test("denied storage does not disable remapping and successful save clears the warning", () => {
  let denied = true;
  const saved = storage();
  const store = createControlsStore({
    getItem: () => {
      throw new Error("denied");
    },
    setItem: (key, value) => {
      if (denied) throw new Error("denied");
      saved.setItem(key, value);
    },
  });
  expect(store.getState().storageAvailable).toBe(false);
  store.getState().beginCapture("key", 6, 0, 0);
  store.getState().assign("KeyC");
  expect(store.getState().keyboard[6]).toBe("KeyC");
  expect(store.getState().storageAvailable).toBe(false);
  denied = false;
  store.getState().reset();
  expect(store.getState().keyboard[6]).toBe("KeyX");
  expect(store.getState().storageAvailable).toBe(true);
  expect(store.getState().notice).toEqual({ kind: "reset" });
});

test("ordinary controller samples do not publish store updates", () => {
  const store = createControlsStore(storage());
  let notifications = 0;
  store.subscribe(() => {
    ++notifications;
  });
  store.getState().sampleGamepad(42, 1 << 6);
  store.getState().sampleGamepad(42, 0);
  expect(notifications).toBe(0);
  store.getState().beginCapture("pad", 6, 42, 0);
  store.getState().sampleGamepad(42, 0);
  store.getState().sampleGamepad(42, 0);
  expect(notifications).toBe(1);
});
