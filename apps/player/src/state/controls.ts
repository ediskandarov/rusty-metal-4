import { createStore } from "zustand/vanilla";

const defaultKeys = [
  "KeyW",
  "KeyE",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyD",
  "KeyX",
  "KeyZ",
  "Backspace",
  "Digit1",
  "Digit2",
  "Enter",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "ArrowLeft",
];
const defaultPad = Array.from({ length: 16 }, (_, index) => index);
const storageKey = "tm4-browser-input-v1";
export const bindableKey =
  /^(Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(?:Up|Down|Left|Right)|Space|Enter|Backspace|Insert|Delete|Home|End|PageUp|PageDown|Shift(?:Left|Right)|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/;
function validMap<T>(value: unknown, isValid: (value: unknown) => value is T): value is T[] {
  return (
    Array.isArray(value) &&
    value.length === defaultKeys.length &&
    value.every(isValid) &&
    new Set(value).size === defaultKeys.length
  );
}

interface Capture {
  kind: "key" | "pad";
  target: number;
  device: number;
  phase: "press" | "release" | "multiple";
}
type Notice =
  | { kind: "assigned"; target: number; source: string | number; previous: number }
  | { kind: "reset" | "disconnected" }
  | null;
interface ControlsState {
  keyboard: readonly string[];
  gamepads: readonly (readonly number[])[];
  player: number;
  storageAvailable: boolean;
  capture: Capture | null;
  notice: Notice;
  selectPlayer: (player: number) => void;
  beginCapture: (kind: Capture["kind"], target: number, device: number, buttons: number) => void;
  cancelCapture: () => void;
  assign: (source: string | number) => void;
  sampleGamepad: (device: number, buttons: number) => void;
  clearNotice: () => void;
  reset: () => void;
}

const browserStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
};

export function createControlsStore(
  storage: Pick<Storage, "getItem" | "setItem"> = browserStorage,
) {
  let keyboard = [...defaultKeys];
  let gamepads = Array.from({ length: 4 }, () => [...defaultPad]);
  let storageAvailable = true;
  try {
    const stored = storage.getItem(storageKey);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      const config = parsed && typeof parsed === "object" ? parsed : {};
      const savedKeyboard = "keyboard" in config ? config.keyboard : undefined;
      const savedPads: unknown[] =
        "gamepads" in config && Array.isArray(config.gamepads) ? config.gamepads : [];
      if (
        validMap(
          savedKeyboard,
          (code): code is string => typeof code === "string" && bindableKey.test(code),
        )
      )
        keyboard = savedKeyboard;
      gamepads = gamepads.map((fallback, slot) => {
        const map = savedPads[slot];
        return validMap(
          map,
          (source): source is number =>
            typeof source === "number" &&
            Number.isInteger(source) &&
            source >= 0 &&
            source < defaultKeys.length,
        )
          ? map
          : fallback;
      });
    }
  } catch (error) {
    // Malformed values use defaults, and can be overwritten with new preferences.
    storageAvailable = error instanceof SyntaxError;
  }

  const store = createStore<ControlsState>()((set, get) => ({
    keyboard,
    gamepads,
    storageAvailable,
    player: 0,
    capture: null,
    notice: null,
    selectPlayer(player) {
      if (!Number.isInteger(player) || player < 0 || player >= get().gamepads.length) return;
      set({ player, capture: null, notice: null });
    },
    beginCapture(kind, target, device, buttons) {
      if (!Number.isInteger(target) || target < 0 || target >= defaultKeys.length) return;
      if ((kind === "pad" && !device) || (kind === "key" && get().player !== 0)) return;
      set({
        capture: { kind, target, device, phase: buttons ? "release" : "press" },
        notice: null,
      });
    },
    cancelCapture() {
      if (get().capture) set({ capture: null });
    },
    assign(source) {
      const { capture, keyboard, gamepads, player } = get();
      if (!capture) return;
      const { kind, target } = capture;
      let previous: number;
      let changes: Partial<ControlsState>;
      if (kind === "key" && typeof source === "string" && bindableKey.test(source)) {
        const map = [...keyboard];
        previous = swapBinding(map, target, source);
        changes = { keyboard: map };
      } else if (
        kind === "pad" &&
        typeof source === "number" &&
        Number.isInteger(source) &&
        source >= 0 &&
        source < defaultKeys.length
      ) {
        const map = [...gamepads[player]!];
        previous = swapBinding(map, target, source);
        changes = { gamepads: gamepads.map((old, slot) => (slot === player ? map : old)) };
      } else return;
      set({ ...changes, capture: null, notice: { kind: "assigned", target, source, previous } });
      persist();
    },
    sampleGamepad(device, buttons) {
      const capture = get().capture;
      if (capture?.kind !== "pad") return;
      if (device !== capture.device) {
        set({ capture: null, notice: { kind: "disconnected" } });
      } else if (!buttons && capture.phase !== "press") {
        set({ capture: { ...capture, phase: "press" } });
      } else if (capture.phase === "press" && buttons) {
        if ((buttons & (buttons - 1)) === 0) get().assign(31 - Math.clz32(buttons));
        else set({ capture: { ...capture, phase: "multiple" } });
      }
    },
    clearNotice: () => set({ notice: null }),
    reset() {
      set({
        keyboard: [...defaultKeys],
        gamepads: get().gamepads.map(() => [...defaultPad]),
        capture: null,
        notice: { kind: "reset" },
      });
      persist();
    },
  }));
  function persist() {
    const { keyboard, gamepads } = store.getState();
    try {
      storage.setItem(storageKey, JSON.stringify({ keyboard, gamepads }));
      store.setState({ storageAvailable: true });
    } catch {
      store.setState({ storageAvailable: false });
    }
  }
  return store;
}

function swapBinding<T>(map: T[], target: number, source: T) {
  const previous = map.indexOf(source);
  if (previous >= 0) map[previous] = map[target]!;
  map[target] = source;
  return previous;
}

export type ControlsStore = ReturnType<typeof createControlsStore>;
