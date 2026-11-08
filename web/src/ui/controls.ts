import type { GameModule } from "../runtime/module.ts";
import { element, item } from "./dom.ts";

// PS1 packet bit order. Controller names describe positions across brands.
const buttons: [name: string, symbol: string, description: string, x: number, y: number][] = [
  ["L2", "L2", "Left trigger", 66, 13],
  ["R2", "R2", "Right trigger", 334, 13],
  ["L1", "L1", "Left bumper", 66, 36],
  ["R1", "R1", "Right bumper", 334, 36],
  ["Triangle", "△", "Top face", 325, 66],
  ["Circle", "○", "Right face", 351, 92],
  ["Cross", "×", "Bottom face", 325, 118],
  ["Square", "□", "Left face", 299, 92],
  ["Select", "Select", "Back / View", 173, 75],
  ["L3", "L3", "Left stick click", 149, 114],
  ["R3", "R3", "Right stick click", 251, 114],
  ["Start", "Start", "Start / Menu", 227, 75],
  ["Up", "↑", "D-pad up", 75, 74],
  ["Right", "→", "D-pad right", 95, 93],
  ["Down", "↓", "D-pad down", 75, 112],
  ["Left", "←", "D-pad left", 55, 93],
];
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
const defaultPad = buttons.map((_, index) => index);
// Tm4GameControl enum order. Button masks come from the live game or menu.
const actions = [
  "Steer left",
  "Steer right",
  "Brake",
  "Handbrake",
  "Accelerate",
  "Reverse",
  "Next weapon",
  "Previous weapon",
  "Machine guns",
  "Fire selected weapon",
  "Turbo",
  "Look back",
];
const fixedActions: Record<number, string> = {
  4: "Back in menus",
  6: "Confirm in menus",
  11: "Pause / Start",
  12: "Menu up",
  13: "Menu right",
  14: "Menu down",
  15: "Menu left",
};
const storageKey = "tm4-browser-input-v1";
const bindableKey =
  /^(Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(?:Up|Down|Left|Right)|Space|Enter|Backspace|Insert|Delete|Home|End|PageUp|PageDown|Shift(?:Left|Right)|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/;
const keyLabels: Record<string, string> = {
  ArrowUp: "↑",
  ArrowRight: "→",
  ArrowDown: "↓",
  ArrowLeft: "←",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  PageUp: "Page Up",
  PageDown: "Page Down",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num −",
  NumpadMultiply: "Num ×",
  NumpadDivide: "Num ÷",
  NumpadDecimal: "Num .",
  NumpadEnter: "Num Enter",
};

function describeKey(code: string) {
  return keyLabels[code] || code.replace(/^(Key|Digit)/, "").replace(/^Numpad/, "Num ");
}

function validMap<T>(value: unknown, isValid: (value: unknown) => value is T): value is T[] {
  return (
    Array.isArray(value) &&
    value.length === buttons.length &&
    value.every(isValid) &&
    new Set(value).size === buttons.length
  );
}

export function initializeInputSettings(
  module: GameModule,
  toolbar: HTMLElement,
  settings: HTMLDetailsElement,
  canvas: HTMLCanvasElement,
) {
  const playerSelect = element("input-player", HTMLSelectElement);
  const device = element("input-device", HTMLElement);
  const captureBox = element("input-capture", HTMLElement);
  const prompt = element("input-capture-prompt", HTMLElement);
  const cancel = element("input-cancel", HTMLElement);
  const message = element("input-message", HTMLElement);
  const list = element("input-map", HTMLElement);
  const controller = settings.querySelector<HTMLElement>(".input-controller");
  if (!controller) throw new Error("Missing controller diagram");
  let keyboard = [...defaultKeys];
  let gamepads = Array.from({ length: 4 }, () => [...defaultPad]);
  let storageAvailable = true;
  try {
    const stored = localStorage.getItem(storageKey);
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
            source < buttons.length,
        )
          ? map
          : fallback;
      });
    }
  } catch (error) {
    // Malformed values use defaults, and can be overwritten with new preferences.
    storageAvailable = error instanceof SyntaxError;
  }

  let player = 0;
  let focused = document.hasFocus();
  let blocked = false;
  let capture: {
    kind: "key" | "pad";
    target: number;
    id: number;
    origin: HTMLElement | null;
    armed: boolean;
  } | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  const down = new Set<string>();
  const activeKeys = new Set<string>();
  const bit = (index: number) => 1 << index;
  const keyboardMask = (keys: Set<string>) =>
    keyboard.reduce((mask, code, index) => mask | (keys.has(code) ? bit(index) : 0), 0);

  function updateBlocked() {
    const next =
      !focused || document.hidden || settings.open || toolbar.contains(document.activeElement);
    if (next && !blocked) activeKeys.clear();
    blocked = next;
    module._WebSetInputBlocked(Number(blocked));
    module._WebSetKeyboardButtons(blocked ? 0 : keyboardMask(activeKeys));
  }

  function applyMaps() {
    for (const [slot, map] of gamepads.entries())
      map.forEach((source, target) => module._WebMapGamepadButton(slot, target, source));
    updateBlocked();
  }

  function saveMaps(text: string) {
    applyMaps();
    try {
      localStorage.setItem(storageKey, JSON.stringify({ keyboard, gamepads }));
      storageAvailable = true;
    } catch {
      storageAvailable = false;
    }
    message.textContent = storageAvailable ? text : `${text} Browser storage is unavailable.`;
  }

  function create<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function makeButton(text: string, handler: () => void) {
    const button = create("button", text);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  for (const [heading, keyboardColumn] of [
    ["PlayStation", false],
    ["Key", true],
    ["Controller", false],
  ] as const) {
    const node = create("span", heading, "input-map-heading");
    if (keyboardColumn) node.dataset.keyboardColumn = "";
    list.append(node);
  }

  const rows = buttons.map(([name, symbol, , x, y], target) => {
    const diagram = makeButton(symbol, () => beginCapture(player === 0 ? "key" : "pad", target));
    diagram.className = "input-diagram-button";
    diagram.style.left = `${x / 4}%`;
    diagram.style.top = `${(y / 184) * 100}%`;
    controller.append(diagram);

    const heading = create("div");
    const action = create("span", "", "input-action");
    heading.append(create("span", name, "input-button-name"), action);
    const key = makeButton("", () => beginCapture("key", target));
    key.dataset.keyboardColumn = "";
    const pad = makeButton("", () => beginCapture("pad", target));
    return { diagram, heading, action, key, pad };
  });
  for (const target of [4, 5, 6, 7, 2, 3, 0, 1, 12, 13, 14, 15, 9, 10, 8, 11]) {
    const { heading, key, pad } = item(rows, target);
    list.append(heading, key, pad);
  }

  function finishCapture(restoreFocus = true) {
    if (!capture) return;
    const { kind, target, origin } = capture;
    capture = null;
    captureBox.hidden = true;
    item(rows, target).diagram.removeAttribute("data-selected");
    if (restoreFocus && settings.open) {
      const { key, pad } = item(rows, target);
      (origin?.matches("button:not(:disabled)") ? origin : kind === "key" ? key : pad).focus({
        preventScroll: true,
      });
    }
  }

  function beginCapture(kind: "key" | "pad", target: number) {
    const id = module._WebGetInputDevice(player);
    if (kind === "pad" && !id) return;
    finishCapture(false);
    capture = {
      kind,
      target,
      id,
      origin: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      armed: !module._WebGetPhysicalButtons(player),
    };
    message.textContent = "";
    prompt.textContent =
      kind === "key"
        ? `Press a key for ${item(buttons, target)[0]}.`
        : `${capture.armed ? "Press a controller button" : "Release held buttons"} for ${item(buttons, target)[0]}.`;
    captureBox.hidden = false;
    item(rows, target).diagram.dataset.selected = "";
    cancel.focus({ preventScroll: true });
  }

  function assign(source: string | number) {
    if (!capture) return;
    const { kind, target } = capture;
    let previous: number;
    if (kind === "key" && typeof source === "string") {
      previous = swapBinding(keyboard, target, source);
    } else if (kind === "pad" && typeof source === "number") {
      previous = swapBinding(item(gamepads, player), target, source);
    } else {
      return;
    }
    finishCapture();
    const name = item(buttons, target)[0];
    const input = typeof source === "string" ? describeKey(source) : item(buttons, source)[2];
    saveMaps(
      previous >= 0 && previous !== target
        ? `${name} and ${item(buttons, previous)[0]} inputs swapped.`
        : `${name} assigned to ${input}.`,
    );
    refresh();
  }

  function refresh() {
    const id = module._WebGetInputDevice(player);
    const raw = module._WebGetPhysicalButtons(player);
    if (capture?.kind === "pad") {
      if (id !== capture.id) {
        finishCapture(false);
        playerSelect.focus({ preventScroll: true });
        message.textContent = "Controller disconnected. Assignment canceled.";
      } else if (!raw && !capture.armed) {
        capture.armed = true;
        prompt.textContent = `Press a controller button for ${item(buttons, capture.target)[0]}.`;
      } else if (capture.armed && raw) {
        if ((raw & (raw - 1)) === 0) {
          assign(31 - Math.clz32(raw));
          return;
        }
        capture.armed = false;
        prompt.textContent = "Release all buttons, then press just one.";
      }
    }

    const connection =
      player === 0
        ? `Keyboard · ${id ? "Controller connected" : "No controller connected"}`
        : id
          ? "Controller connected"
          : "No controller connected";
    if (device.textContent !== connection) device.textContent = connection;
    element("input-sticks", HTMLElement).hidden = !id;
    list.toggleAttribute("data-no-keyboard", player !== 0);
    const pressedKeys = player === 0 ? keyboardMask(down) : 0;
    const bindings = actions.map((_, action) => module._WebGetControlAction(player, action));
    rows.forEach(({ diagram, action, key, pad }, target) => {
      const [name] = item(buttons, target);
      const source = item(item(gamepads, player), target);
      const keyText = describeKey(item(keyboard, target));
      const padText = item(buttons, source)[2];
      const fromKeyboard = !!(pressedKeys & bit(target));
      const fromPad = !!(raw & bit(source));
      const actionNames = actions.filter((_, index) => (bindings[index] ?? 0) & bit(target));
      const fixedAction = fixedActions[target];
      if (fixedAction) actionNames.push(fixedAction);
      const actionText = actionNames.join(" · ");
      if (action.textContent !== actionText) action.textContent = actionText;
      if (key.textContent !== keyText) {
        key.textContent = keyText;
        key.setAttribute("aria-label", `Change ${name} key, currently ${keyText}`);
      }
      if (pad.textContent !== padText) {
        pad.textContent = padText;
        pad.setAttribute("aria-label", `Change ${name} controller button, currently ${padText}`);
      }
      const hint = `${name}: ${player === 0 ? keyText + " / " : ""}${padText}`;
      if (diagram.title !== hint) {
        diagram.title = hint;
        diagram.setAttribute(
          "aria-label",
          `Change ${name} using ${player === 0 ? "keyboard" : "controller"}`,
        );
      }
      diagram.disabled = player !== 0 && !id;
      pad.disabled = !id;
      diagram.toggleAttribute("data-active", fromKeyboard || fromPad);
      key.toggleAttribute("data-active", fromKeyboard);
      pad.toggleAttribute("data-active", fromPad);
    });
  }

  function close() {
    finishCapture(false);
    settings.open = false;
    canvas.focus();
    updateBlocked();
  }

  settings.addEventListener("toggle", () => {
    clearInterval(interval);
    if (settings.open) {
      message.textContent = storageAvailable ? "" : "Browser storage is unavailable.";
      refresh();
      interval = setInterval(refresh, 50);
    } else {
      finishCapture(false);
      if (settings.contains(document.activeElement)) canvas.focus();
    }
    updateBlocked();
  });
  playerSelect.addEventListener("change", () => {
    finishCapture(false);
    message.textContent = "";
    player = Number(playerSelect.value);
    refresh();
  });
  cancel.addEventListener("click", () => finishCapture());
  element("input-close", HTMLElement).addEventListener("click", close);
  element("input-reset", HTMLElement).addEventListener("click", () => {
    finishCapture(false);
    keyboard = [...defaultKeys];
    gamepads = gamepads.map(() => [...defaultPad]);
    saveMaps("Original input defaults restored.");
    refresh();
  });

  document.addEventListener("focusin", updateBlocked);
  toolbar.addEventListener("focusout", () => queueMicrotask(updateBlocked));
  window.addEventListener("blur", () => {
    focused = false;
    down.clear();
    finishCapture();
    updateBlocked();
  });
  window.addEventListener("focus", () => {
    focused = true;
    updateBlocked();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      down.clear();
      finishCapture();
    }
    updateBlocked();
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.repeat) down.add(event.code);
      if (settings.open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          if (capture) finishCapture();
          else close();
        }
        return;
      }
      if (capture?.kind === "key" && settings.open) {
        if (event.key === "Tab") return;
        event.preventDefault();
        event.stopPropagation();
        if (
          !event.repeat &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          bindableKey.test(event.code)
        )
          assign(event.code);
        return;
      }
      if (
        !blocked &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !(event.target instanceof Node && toolbar.contains(event.target))
      ) {
        activeKeys.add(event.code);
        updateBlocked();
      }
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (event) => {
      down.delete(event.code);
      if (activeKeys.delete(event.code)) updateBlocked();
    },
    true,
  );

  applyMaps();
}

function swapBinding<T>(map: T[], target: number, source: T): number {
  const previous = map.indexOf(source);
  if (previous >= 0) map[previous] = item(map, target);
  map[target] = source;
  return previous;
}
