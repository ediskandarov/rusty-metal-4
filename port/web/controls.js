// PS1 packet bit order. Controller names describe positions across brands.
const buttons = [
  ['L2', 'L2', 'Left trigger', 66, 13],
  ['R2', 'R2', 'Right trigger', 334, 13],
  ['L1', 'L1', 'Left bumper', 66, 36],
  ['R1', 'R1', 'Right bumper', 334, 36],
  ['Triangle', '△', 'Top face', 325, 66],
  ['Circle', '○', 'Right face', 351, 92],
  ['Cross', '×', 'Bottom face', 325, 118],
  ['Square', '□', 'Left face', 299, 92],
  ['Select', 'Select', 'Back / View', 173, 75],
  ['L3', 'L3', 'Left stick click', 149, 114],
  ['R3', 'R3', 'Right stick click', 251, 114],
  ['Start', 'Start', 'Start / Menu', 227, 75],
  ['Up', '↑', 'D-pad up', 75, 74],
  ['Right', '→', 'D-pad right', 95, 93],
  ['Down', '↓', 'D-pad down', 75, 112],
  ['Left', '←', 'D-pad left', 55, 93],
];
const defaultKeys = [
  'KeyW', 'KeyE', 'KeyQ', 'KeyR', 'KeyS', 'KeyD', 'KeyX', 'KeyZ', 'Backspace',
  'Digit1', 'Digit2', 'Enter', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft',
];
const defaultPad = buttons.map((_, index) => index);
// Tm4GameControl enum order. Button masks come from the live game or menu.
const actions = [
  'Steer left', 'Steer right', 'Brake', 'Handbrake', 'Accelerate', 'Reverse',
  'Next weapon', 'Previous weapon', 'Machine guns', 'Fire selected weapon', 'Turbo', 'Look back',
];
const fixedActions = {
  4: 'Back in menus', 6: 'Confirm in menus', 11: 'Pause / Start',
  12: 'Menu up', 13: 'Menu right', 14: 'Menu down', 15: 'Menu left',
};
const storageKey = 'tm4-browser-input-v1';
const bindableKey = /^(Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(?:Up|Down|Left|Right)|Space|Enter|Backspace|Insert|Delete|Home|End|PageUp|PageDown|Shift(?:Left|Right)|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/;
const keyLabels = {
  ArrowUp: '↑', ArrowRight: '→', ArrowDown: '↓', ArrowLeft: '←',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', PageUp: 'Page Up', PageDown: 'Page Down',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num −', NumpadMultiply: 'Num ×', NumpadDivide: 'Num ÷',
  NumpadDecimal: 'Num .', NumpadEnter: 'Num Enter',
};

function describeKey(code) {
  return keyLabels[code] || code.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'Num ');
}

function validMap(value, isValid) {
  return Array.isArray(value) && value.length === buttons.length &&
    value.every(isValid) && new Set(value).size === buttons.length;
}

export function initializeInputSettings(module, toolbar, settings, canvas) {
  const element = id => document.getElementById(id);
  const playerSelect = element('input-player');
  const device = element('input-device');
  const captureBox = element('input-capture');
  const prompt = element('input-capture-prompt');
  const cancel = element('input-cancel');
  const message = element('input-message');
  const list = element('input-map');
  const controller = settings.querySelector('.input-controller');
  let keyboard = [...defaultKeys];
  let gamepads = Array.from({ length: 4 }, () => [...defaultPad]);
  let storageAvailable = true;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) {
      const config = JSON.parse(stored);
      if (validMap(config?.keyboard, code => typeof code === 'string' && bindableKey.test(code)))
        keyboard = config.keyboard;
      gamepads = gamepads.map((fallback, slot) => {
        const map = config?.gamepads?.[slot];
        return validMap(map, source => Number.isInteger(source) && source >= 0 && source < buttons.length)
          ? map : fallback;
      });
    }
  } catch (error) {
    // Malformed values use defaults, and can be overwritten with new preferences.
    storageAvailable = error instanceof SyntaxError;
  }

  let player = 0;
  let focused = document.hasFocus();
  let blocked = false;
  let capture = null;
  let interval;
  const down = new Set();
  const activeKeys = new Set();
  const bit = index => 1 << index;
  const keyboardMask = keys => keyboard.reduce((mask, code, index) => mask | (keys.has(code) ? bit(index) : 0), 0);

  function updateBlocked() {
    const next = !focused || document.hidden || settings.open ||
      toolbar.contains(document.activeElement);
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

  function saveMaps(text) {
    applyMaps();
    try {
      localStorage.setItem(storageKey, JSON.stringify({ keyboard, gamepads }));
      storageAvailable = true;
    } catch {
      storageAvailable = false;
    }
    message.textContent = storageAvailable ? text : `${text} Browser storage is unavailable.`;
  }

  function create(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function makeButton(text, handler) {
    const button = create('button', text);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }

  for (const [heading, keyboardColumn] of [['PlayStation', false], ['Key', true], ['Controller', false]]) {
    const node = create('span', heading, 'input-map-heading');
    if (keyboardColumn) node.dataset.keyboardColumn = '';
    list.append(node);
  }

  const rows = buttons.map(([name, symbol, , x, y], target) => {
    const diagram = makeButton(symbol, () => beginCapture(player === 0 ? 'key' : 'pad', target));
    diagram.className = 'input-diagram-button';
    diagram.style.left = `${x / 4}%`;
    diagram.style.top = `${y / 184 * 100}%`;
    controller.append(diagram);

    const heading = create('div');
    const action = create('span', '', 'input-action');
    heading.append(create('span', name, 'input-button-name'), action);
    const key = makeButton('', () => beginCapture('key', target));
    key.dataset.keyboardColumn = '';
    const pad = makeButton('', () => beginCapture('pad', target));
    return { diagram, heading, action, key, pad };
  });
  for (const target of [4, 5, 6, 7, 2, 3, 0, 1, 12, 13, 14, 15, 9, 10, 8, 11]) {
    const { heading, key, pad } = rows[target];
    list.append(heading, key, pad);
  }

  function finishCapture(restoreFocus = true) {
    if (!capture) return;
    const { kind, target, origin } = capture;
    capture = null;
    captureBox.hidden = true;
    rows[target].diagram.removeAttribute('data-selected');
    if (restoreFocus && settings.open) {
      const { key, pad } = rows[target];
      (origin?.matches('button:not(:disabled)') ? origin : kind === 'key' ? key : pad)
        .focus({ preventScroll: true });
    }
  }

  function beginCapture(kind, target) {
    const id = module._WebGetInputDevice(player);
    if (kind === 'pad' && !id) return;
    finishCapture(false);
    capture = {
      kind, target, id, origin: document.activeElement,
      armed: !module._WebGetPhysicalButtons(player),
    };
    message.textContent = '';
    prompt.textContent = kind === 'key' ? `Press a key for ${buttons[target][0]}.` :
      `${capture.armed ? 'Press a controller button' : 'Release held buttons'} for ${buttons[target][0]}.`;
    captureBox.hidden = false;
    rows[target].diagram.dataset.selected = '';
    cancel.focus({ preventScroll: true });
  }

  function assign(source) {
    const { kind, target } = capture;
    const map = kind === 'key' ? keyboard : gamepads[player];
    const previous = map.indexOf(source);
    if (previous >= 0) map[previous] = map[target];
    map[target] = source;
    finishCapture();
    const name = buttons[target][0];
    const input = kind === 'key' ? describeKey(source) : buttons[source][2];
    saveMaps(previous >= 0 && previous !== target ?
      `${name} and ${buttons[previous][0]} inputs swapped.` : `${name} assigned to ${input}.`);
    refresh();
  }

  function refresh() {
    const id = module._WebGetInputDevice(player);
    const raw = module._WebGetPhysicalButtons(player);
    if (capture?.kind === 'pad') {
      if (id !== capture.id) {
        finishCapture(false);
        playerSelect.focus({ preventScroll: true });
        message.textContent = 'Controller disconnected. Assignment canceled.';
      } else if (!raw && !capture.armed) {
        capture.armed = true;
        prompt.textContent = `Press a controller button for ${buttons[capture.target][0]}.`;
      } else if (capture.armed && raw) {
        if ((raw & (raw - 1)) === 0) {
          assign(31 - Math.clz32(raw));
          return;
        }
        capture.armed = false;
        prompt.textContent = 'Release all buttons, then press just one.';
      }
    }

    const connection = player === 0 ?
      `Keyboard · ${id ? 'Controller connected' : 'No controller connected'}` :
      id ? 'Controller connected' : 'No controller connected';
    if (device.textContent !== connection) device.textContent = connection;
    element('input-sticks').hidden = !id;
    list.toggleAttribute('data-no-keyboard', player !== 0);
    const pressedKeys = player === 0 ? keyboardMask(down) : 0;
    const bindings = actions.map((_, action) => module._WebGetControlAction(player, action));
    rows.forEach(({ diagram, action, key, pad }, target) => {
      const [name] = buttons[target];
      const source = gamepads[player][target];
      const keyText = describeKey(keyboard[target]);
      const padText = buttons[source][2];
      const fromKeyboard = !!(pressedKeys & bit(target));
      const fromPad = !!(raw & bit(source));
      const actionNames = actions.filter((_, index) => bindings[index] & bit(target));
      if (fixedActions[target]) actionNames.push(fixedActions[target]);
      const actionText = actionNames.join(' · ');
      if (action.textContent !== actionText) action.textContent = actionText;
      if (key.textContent !== keyText) {
        key.textContent = keyText;
        key.setAttribute('aria-label', `Change ${name} key, currently ${keyText}`);
      }
      if (pad.textContent !== padText) {
        pad.textContent = padText;
        pad.setAttribute('aria-label', `Change ${name} controller button, currently ${padText}`);
      }
      const hint = `${name}: ${player === 0 ? keyText + ' / ' : ''}${padText}`;
      if (diagram.title !== hint) {
        diagram.title = hint;
        diagram.setAttribute('aria-label', `Change ${name} using ${player === 0 ? 'keyboard' : 'controller'}`);
      }
      diagram.disabled = player !== 0 && !id;
      pad.disabled = !id;
      diagram.toggleAttribute('data-active', fromKeyboard || fromPad);
      key.toggleAttribute('data-active', fromKeyboard);
      pad.toggleAttribute('data-active', fromPad);
    });
  }

  function close() {
    finishCapture(false);
    settings.open = false;
    canvas.focus();
    updateBlocked();
  }

  settings.addEventListener('toggle', () => {
    clearInterval(interval);
    if (settings.open) {
      message.textContent = storageAvailable ? '' : 'Browser storage is unavailable.';
      refresh();
      interval = setInterval(refresh, 50);
    } else {
      finishCapture(false);
      if (settings.contains(document.activeElement)) canvas.focus();
    }
    updateBlocked();
  });
  playerSelect.addEventListener('change', () => {
    finishCapture(false);
    message.textContent = '';
    player = Number(playerSelect.value);
    refresh();
  });
  cancel.addEventListener('click', () => finishCapture());
  element('input-close').addEventListener('click', close);
  element('input-reset').addEventListener('click', () => {
    finishCapture(false);
    keyboard = [...defaultKeys];
    gamepads = gamepads.map(() => [...defaultPad]);
    saveMaps('Original input defaults restored.');
    refresh();
  });

  document.addEventListener('focusin', updateBlocked);
  toolbar.addEventListener('focusout', () => queueMicrotask(updateBlocked));
  window.addEventListener('blur', () => {
    focused = false;
    down.clear();
    finishCapture();
    updateBlocked();
  });
  window.addEventListener('focus', () => {
    focused = true;
    updateBlocked();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      down.clear();
      finishCapture();
    }
    updateBlocked();
  });
  window.addEventListener('keydown', event => {
    if (!event.repeat) down.add(event.code);
    if (settings.open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        if (capture) finishCapture();
        else close();
      }
      return;
    }
    if (capture?.kind === 'key' && settings.open) {
      if (event.key === 'Tab') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey &&
          bindableKey.test(event.code))
        assign(event.code);
      return;
    }
    if (!blocked && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey &&
        !toolbar.contains(event.target)) {
      activeKeys.add(event.code);
      updateBlocked();
    }
  }, true);
  window.addEventListener('keyup', event => {
    down.delete(event.code);
    if (activeKeys.delete(event.code)) updateBlocked();
  }, true);

  applyMaps();
}
