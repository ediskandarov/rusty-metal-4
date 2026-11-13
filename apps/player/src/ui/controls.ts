import type { GameModule } from "@tm4/game-runtime/runtime/module";

import { bindableKey, createControlsStore } from "../state/controls.ts";
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
  const store = createControlsStore();
  let focused = document.hasFocus();
  let blocked = false;
  let captureOrigin: HTMLElement | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  const down = new Set<string>();
  const activeKeys = new Set<string>();
  const bit = (index: number) => 1 << index;
  const keyboardMask = (keys: Set<string>) =>
    store
      .getState()
      .keyboard.reduce((mask, code, index) => mask | (keys.has(code) ? bit(index) : 0), 0);

  function updateBlocked() {
    const next =
      !focused || document.hidden || settings.open || toolbar.contains(document.activeElement);
    if (next && !blocked) activeKeys.clear();
    blocked = next;
    module._WebSetInputBlocked(Number(blocked));
    module._WebSetKeyboardButtons(blocked ? 0 : keyboardMask(activeKeys));
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
    const diagram = makeButton(symbol, () =>
      beginCapture(store.getState().player === 0 ? "key" : "pad", target),
    );
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

  function restoreCaptureFocus(capture: NonNullable<ReturnType<typeof store.getState>["capture"]>) {
    if (!settings.open) return;
    const { key, pad } = item(rows, capture.target);
    (captureOrigin?.matches("button:not(:disabled)")
      ? captureOrigin
      : capture.kind === "key"
        ? key
        : pad
    ).focus({ preventScroll: true });
  }

  function finishCapture(restoreFocus = true) {
    const capture = store.getState().capture;
    if (!capture) return;
    store.getState().cancelCapture();
    if (restoreFocus) restoreCaptureFocus(capture);
    captureOrigin = null;
  }

  function beginCapture(kind: "key" | "pad", target: number) {
    const player = store.getState().player;
    const id = module._WebGetInputDevice(player);
    if (kind === "pad" && !id) return;
    finishCapture(false);
    captureOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    store.getState().beginCapture(kind, target, id, module._WebGetPhysicalButtons(player));
    if (store.getState().capture) cancel.focus({ preventScroll: true });
  }

  function render() {
    const { player, keyboard, gamepads, capture, notice, storageAvailable } = store.getState();
    playerSelect.value = String(player);
    captureBox.hidden = !capture;
    if (capture) {
      const name = item(buttons, capture.target)[0];
      prompt.textContent =
        capture.kind === "key"
          ? `Press a key for ${name}.`
          : capture.phase === "multiple"
            ? "Release all buttons, then press just one."
            : `${capture.phase === "press" ? "Press a controller button" : "Release held buttons"} for ${name}.`;
    }
    let text = "";
    if (notice?.kind === "disconnected") text = "Controller disconnected. Assignment canceled.";
    else if (notice?.kind === "reset") text = "Original input defaults restored.";
    else if (notice?.kind === "assigned") {
      const { target, source, previous } = notice;
      const name = item(buttons, target)[0];
      const input = typeof source === "string" ? describeKey(source) : item(buttons, source)[2];
      text =
        previous >= 0 && previous !== target
          ? `${name} and ${item(buttons, previous)[0]} inputs swapped.`
          : `${name} assigned to ${input}.`;
    }
    message.textContent = storageAvailable
      ? text
      : `${text} Browser storage is unavailable.`.trim();
    const id = module._WebGetInputDevice(player);
    const raw = module._WebGetPhysicalButtons(player);
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
      diagram.toggleAttribute("data-selected", capture?.target === target);
      diagram.disabled = player !== 0 && !id;
      pad.disabled = !id;
      diagram.toggleAttribute("data-active", fromKeyboard || fromPad);
      key.toggleAttribute("data-active", fromKeyboard);
      pad.toggleAttribute("data-active", fromPad);
    });
  }

  function refresh() {
    const { player } = store.getState();
    store
      .getState()
      .sampleGamepad(module._WebGetInputDevice(player), module._WebGetPhysicalButtons(player));
    render();
  }

  store.subscribe((state, previous) => {
    if (state.gamepads !== previous.gamepads) {
      state.gamepads.forEach((map, slot) => {
        if (map !== previous.gamepads[slot])
          map.forEach((source, target) => module._WebMapGamepadButton(slot, target, source));
      });
    }
    if (state.keyboard !== previous.keyboard || state.gamepads !== previous.gamepads)
      updateBlocked();
    render();
    if (previous.capture && !state.capture && state.notice !== previous.notice) {
      if (state.notice?.kind === "assigned") restoreCaptureFocus(previous.capture);
      else if (state.notice?.kind === "disconnected") playerSelect.focus({ preventScroll: true });
      captureOrigin = null;
    }
  });

  function close() {
    finishCapture(false);
    settings.open = false;
    canvas.focus();
    updateBlocked();
  }

  settings.addEventListener("toggle", () => {
    clearInterval(interval);
    if (settings.open) {
      store.getState().clearNotice();
      refresh();
      interval = setInterval(refresh, 50);
    } else {
      finishCapture(false);
      if (settings.contains(document.activeElement)) canvas.focus();
    }
    updateBlocked();
  });
  playerSelect.addEventListener("change", () => {
    const player = Number(playerSelect.value);
    finishCapture(false);
    store.getState().selectPlayer(player);
    refresh();
  });
  cancel.addEventListener("click", () => finishCapture());
  element("input-close", HTMLElement).addEventListener("click", close);
  element("input-reset", HTMLElement).addEventListener("click", () => {
    finishCapture(false);
    store.getState().reset();
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
          if (store.getState().capture) finishCapture();
          else close();
        }
        return;
      }
      if (store.getState().capture?.kind === "key" && settings.open) {
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
          store.getState().assign(event.code);
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

  store
    .getState()
    .gamepads.forEach((map, slot) =>
      map.forEach((source, target) => module._WebMapGamepadButton(slot, target, source)),
    );
  updateBlocked();
  render();
}
