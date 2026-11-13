/* global tm4Port, setTestGamepad, Module */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");

(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    const pads = [];
    navigator.getGamepads = () => pads;
    window.setTestGamepad = (connected, x = 0, y = 0, confirm = false) => {
      const changed = !!pads[0] !== connected;
      const pad = pads[0] || {
        id: "TM4 virtual standard gamepad",
        index: 0,
        mapping: "standard",
        connected: true,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      };
      pad.connected = connected;
      pad.timestamp = performance.now();
      pad.axes = [x, y, 0, 0];
      pad.buttons[0] = { pressed: confirm, touched: confirm, value: confirm ? 1 : 0 };
      pads[0] = connected ? pad : null;
      if (changed) {
        const event = new Event(connected ? "gamepadconnected" : "gamepaddisconnected");
        Object.defineProperty(event, "gamepad", { value: pad });
        window.dispatchEvent(event);
      }
    };
  });
  const screen = (name) =>
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  async function confirm() {
    await page.evaluate(() => setTestGamepad(true, 0, 0, true));
    await page.waitForTimeout(150);
    await page.evaluate(() => setTestGamepad(true));
    await page.waitForTimeout(150);
  }
  try {
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await require("./browser_startup.cjs")(page);
    await page.evaluate(() => setTestGamepad(true));
    await page.waitForTimeout(300);
    const selected = await page.evaluate(() => tm4Port.selected);
    await page.evaluate(() => setTestGamepad(true, 0, 1));
    await page.waitForFunction((previous) => tm4Port.selected !== previous, selected);
    await page.evaluate(() => setTestGamepad(true, 0, -1));
    await page.waitForFunction((previous) => tm4Port.selected === previous, selected);
    await page.evaluate(() => setTestGamepad(true));
    await confirm();
    await screen("newgame");
    await confirm();
    await screen("carsel");
    await confirm();
    await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.carTicks > 30, null, {
      timeout: 30000,
    });
    await page.evaluate(() => setTestGamepad(true, 0.7, -1));
    await page.waitForFunction(() => tm4Port.carThrottle > 0 && tm4Port.carSteering > 10000);
    await page.evaluate(() => setTestGamepad(true, -0.7, -1));
    await page.waitForFunction(() => tm4Port.carSteering < -10000);
    await page.evaluate(() => setTestGamepad(true));
    await page.waitForFunction(
      () => Math.abs(tm4Port.carSteering) < 1000 && tm4Port.carThrottle === 0,
    );
    await page.evaluate(() => setTestGamepad(false));
    await page.waitForTimeout(400);
    await page.keyboard.down("x");
    await page.keyboard.down("ArrowRight");
    await page.waitForFunction(() => tm4Port.carThrottle > 0 && tm4Port.carSteering > 10000);
    await page.keyboard.up("x");
    await page.keyboard.up("ArrowRight");
    assert.deepEqual(
      await page.evaluate(() => [
        Module._WebTestTeleportCamera(0, 0),
        Module._WebTestTeleportCamera(0, 1),
      ]),
      [1, 1],
      "Offline teleporter and hyperspace still snap the player's camera",
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: "build/checks/gamepad-driving.png" });
    console.log(
      "PASS browser gamepad -> PsyZ -> menu, analog steering/throttle, unplug -> keyboard, offline teleporter/hyperspace cameras",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
