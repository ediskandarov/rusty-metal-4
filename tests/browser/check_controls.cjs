/* global setTestPad, Module, tm4Port */
const { startDiagnosticGame, togglePanel, setPanelOpen } = require("./helpers/player.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const assert = require("node:assert/strict");

(async () => {
  const browser = await launchBrowser();
  const url = process.env.TM4_WEB_URL || "http://127.0.0.1:8080/";
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    const pads = [null, null];
    navigator.getGamepads = () => pads;
    window.setTestPad = (index, connected, button = -1, x = 0, y = 0) => {
      const changed = !!pads[index] !== connected;
      const pad = pads[index] || {
        index,
        id: `TM4 test controller ${index}`,
        mapping: "standard",
        timestamp: 0,
        axes: [0, 0, 0, 0],
        buttons: [],
      };
      Object.assign(pad, {
        connected,
        timestamp: performance.now(),
        axes: [x, y, 0, 0],
        buttons: Array.from({ length: 17 }, (_, i) => ({
          pressed: i === button,
          touched: i === button,
          value: Number(i === button),
        })),
      });
      pads[index] = connected ? pad : null;
      if (changed) {
        const event = new Event(connected ? "gamepadconnected" : "gamepaddisconnected");
        Object.defineProperty(event, "gamepad", { value: pad });
        window.dispatchEvent(event);
      }
    };
  });
  const settings = page.locator("#input-settings");
  const open = () => setPanelOpen(page, "input-settings", true);
  const close = () => page.locator("#input-close").click();
  const key = (name) => page.getByRole("button", { name: new RegExp(`^Change ${name} key,`) });
  const pad = (name) =>
    page.getByRole("button", { name: new RegExp(`^Change ${name} controller button,`) });
  const setPad = (...args) => page.evaluate((args) => setTestPad(...args), args);
  const read = (f, arg) => page.waitForFunction(f, arg, { timeout: 10000 });
  const padButtons = (expected, port = 0) =>
    read(([port, expected]) => Module._WebTestGetPadButtons(port) === expected, [port, expected]);
  const menu = (name) => read((name) => tm4Port.screen === name && tm4Port.menuReady, name);
  const press = async (name) => {
    await page.keyboard.press(name, { delay: 140 });
    await page.waitForTimeout(140);
  };

  try {
    await page.goto(url);
    await startDiagnosticGame(page);
    await open();
    assert.equal(await key("Cross").textContent(), "X");
    assert.equal(await pad("Cross").textContent(), "Bottom face");
    assert(await page.getByText("Accelerate · Confirm in menus", { exact: true }).isVisible());
    await key("Cross").click();
    await page.keyboard.press("Escape");
    assert.equal(await settings.evaluate((el) => el.open), true);
    assert.equal(await page.locator("#input-capture").isVisible(), false);
    assert.equal(await key("Cross").textContent(), "X");

    // Cross takes Z and Square takes X. The held capture key cannot confirm a menu.
    await key("Cross").click();
    await page.keyboard.down("z");
    assert.equal(await key("Cross").textContent(), "Z");
    assert.equal(await key("Square").textContent(), "X");
    await padButtons(0);
    await close();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => tm4Port.screen), "main");
    await padButtons(0);
    await page.keyboard.up("z");
    await page.keyboard.down("x");
    await padButtons(0x80);
    await page.keyboard.up("x");
    await press("z");
    await menu("newgame");
    await press("z");
    await menu("carsel");

    // The original settings can assign an additional PlayStation button to gas.
    // The browser should read the edited action and still map the same physical keys.
    await press("x");
    await menu("psetting"); // The swapped Square.
    await press("ArrowDown");
    await press("ArrowDown");
    await press("z");
    await menu("controll");
    for (let i = 0; i < 4; i++) await press("ArrowDown");
    await read(() => tm4Port.controlAction === 4);
    await press("z");
    await press("ArrowUp");
    await read(() => tm4Port.menuGasBinding === 0x1040);
    await open();
    await page
      .getByText("Accelerate · Menu up", { exact: true })
      .waitFor({ state: "visible", timeout: 5000 });
    await close();
    await press("r"); // Restore the original game actions.
    await read(() => tm4Port.menuGasBinding === 0x40);
    await press("s");
    await menu("psetting");
    await press("s");
    await menu("carsel");
    await press("z");
    await read(() => tm4Port.screen === "level" && tm4Port.carTicks > 30);
    await page.keyboard.down("z");
    await read(() => tm4Port.carThrottle > 0 && Module._WebTestGetPadButtons(0) === 0x40);
    await open();
    await read(() => tm4Port.carThrottle === 0 && Module._WebTestGetPadButtons(0) === 0);
    await close();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => tm4Port.carThrottle), 0);
    await page.keyboard.up("z");

    // Blur clears a held key and suppresses subsequent input until focus returns.
    await page.keyboard.down("z");
    await read(() => tm4Port.carThrottle > 0);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await read(() => tm4Port.carThrottle === 0);
    await page.keyboard.up("z");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.keyboard.down("z");
    await read(() => tm4Port.carThrottle > 0);
    await page.keyboard.up("z");

    await setPad(0, true);
    await read(() => Module._WebGetInputDevice(0) !== 0);
    await setPad(1, true);
    await read(() => Module._WebGetInputDevice(1) !== 0);
    const secondId = await page.evaluate(() => Module._WebGetInputDevice(1));
    await open();
    // Capture waits for a held south button to be released, then swaps east and south.
    await setPad(0, true, 0);
    await read(() => Module._WebGetPhysicalButtons(0) === 0x40);
    await pad("Cross").click();
    assert.match(await page.locator("#input-capture-prompt").textContent(), /Release held/);
    await setPad(0, true);
    await read(() =>
      /Press a controller button/.test(document.querySelector("#input-capture-prompt").textContent),
    );
    await setPad(0, true, 1);
    await read(() => document.querySelector("#input-capture").hidden);
    assert.equal(await pad("Cross").textContent(), "Right face");
    assert.equal(await pad("Circle").textContent(), "Bottom face");
    assert.equal(await pad("Cross").getAttribute("data-active"), "");
    await padButtons(0);
    await close();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => tm4Port.carThrottle), 0);
    await setPad(0, true);
    await read(() => Module._WebGetPhysicalButtons(0) === 0);
    await setPad(0, true, 1);
    await read(() => tm4Port.carThrottle > 0 && Module._WebTestGetPadButtons(0) === 0x40);
    await setPad(0, true, 0);
    await padButtons(0x20);
    await setPad(0, true, -1, 0.8, -1);
    await read(() => tm4Port.carThrottle > 0 && tm4Port.carSteering > 10000);
    await open();
    await read(() => tm4Port.carThrottle === 0 && Math.abs(tm4Port.carSteering) < 1000);
    await close();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => tm4Port.carThrottle), 0);
    await setPad(0, true);
    await page.waitForTimeout(200);

    // Reconnecting one controller preserves the other player's slot and the remap.
    await open();
    await pad("Cross").click();
    await setPad(0, false);
    await read(() => /disconnected/.test(document.querySelector("#input-message").textContent));
    assert.equal(await page.evaluate(() => Module._WebGetInputDevice(1)), secondId);
    await setPad(0, true);
    await read(() => Module._WebGetInputDevice(0) !== 0);
    assert.equal(await pad("Cross").textContent(), "Right face");
    await page.selectOption("#input-player", "1");
    assert.equal(await key("Cross").count(), 0);
    assert.equal(await pad("Cross").textContent(), "Bottom face");
    await page.selectOption("#input-player", "0");
    assert.equal(await pad("Cross").textContent(), "Right face");

    await togglePanel(page, "render-settings");
    assert.equal(await settings.evaluate((el) => el.open), false);
    await open();
    assert.equal(await page.locator("#render-settings").evaluate((el) => el.open), false);
    await page.screenshot({ path: "build/checks/controls-desktop.png" });
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForFunction(() => {
      const el = document.querySelector("#input-panel");
      const box = el.getBoundingClientRect();
      return (
        box.left >= 0 &&
        box.right <= innerWidth &&
        box.bottom <= innerHeight - 11 &&
        el.scrollWidth <= el.clientWidth
      );
    });
    await page.screenshot({ path: "build/checks/controls-mobile.png" });

    await page.reload();
    await startDiagnosticGame(page);
    await open();
    assert.equal(await key("Cross").textContent(), "Z");
    assert.equal(await pad("Cross").textContent(), "Right face");
    await page.locator("#input-reset").click();
    assert.equal(await key("Cross").textContent(), "X");
    assert.equal(await pad("Cross").textContent(), "Bottom face");

    await page.evaluate(() => localStorage.setItem("tm4-browser-input-v1", "{"));
    await page.reload();
    await startDiagnosticGame(page);
    await open();
    assert.equal(await key("Cross").textContent(), "X");
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Denied", "SecurityError");
      };
    });
    await key("Cross").click();
    await page.keyboard.press("KeyC");
    assert.equal(await key("Cross").textContent(), "C");
    assert.match(
      await page.locator("#input-message").textContent(),
      /Browser storage is unavailable/,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS controls: keyboard/controller remaps reach game, capture/blur isolate input, stable slots, persistence, reset, denied storage and 320 px layout",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
