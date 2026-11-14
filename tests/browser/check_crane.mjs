import assert from "node:assert/strict";

/* global tm4Port, Module */
import diagnostics from "./browser_diagnostics.mjs";
import { launchBrowser } from "./helpers/browser.mjs";
import { startDiagnosticGame } from "./helpers/player.mjs";

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
await diagnostics(page);
const errors = [];
page.on("pageerror", (e) => {
  errors.push(String(e));
  console.error(e);
});
page.on("console", (m) => {
  if (m.type() === "error" && !/^\[[ID]\]/.test(m.text())) {
    errors.push(m.text());
    console.error(m.text());
  }
});
const state = () => page.evaluate(() => tm4Port);
const press = async (key) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(150);
  await page.keyboard.up(key);
  await page.waitForTimeout(150);
};
const screen = (name) =>
  page.waitForFunction((name) => globalThis.tm4Port?.screen === name && tm4Port.menuReady, name, {
    timeout: 30000,
  });
try {
  await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
  await startDiagnosticGame(page);
  await screen("main");
  await page.locator("canvas").click();
  for (let session = 0; session < 2; ++session) {
    await press("x");
    await screen("newgame");
    await press("x");
    await screen("carsel");
    await press("x");
    await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30, null, {
      timeout: 30000,
    });
    assert((await state()).craneInstances > 0);
    assert.equal(await page.evaluate(() => Module._WebTestApproachCrane(0)), 1);
    await page.waitForFunction(
      () => tm4Port.crane?.controlled && tm4Port.crane.cameraAttached,
      null,
      { timeout: 5000 },
    );
    const before = await state();
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(500);
    await page.keyboard.up("ArrowRight");
    await page.waitForFunction((n) => tm4Port.crane.angle !== n, before.crane.angle, {
      timeout: 5000,
    });
    await page.screenshot({ path: `build/checks/crane-${session}-control.png` });
    assert.equal(await page.evaluate(() => Module._WebTestApproachCrane(1)), 1);
    await press("x");
    await page.waitForFunction(() => tm4Port.crane.holding, null, { timeout: 5000 });
    await page.waitForFunction(
      (y) => tm4Port.crane.heldY < y - 100,
      (await state()).testCraneTargetY,
      { timeout: 5000 },
    );
    assert((await state()).craneDraws > (before.craneDraws || 0));
    await page.screenshot({ path: `build/checks/crane-${session}-magnet.png` });
    console.log("PASS crane capture and spring lift", (await state()).crane);
    await press("x");
    await page.waitForFunction(() => !tm4Port.crane.holding);
    await press("s");
    await page.waitForFunction(
      () => !tm4Port.crane.controlled && !tm4Port.crane.cameraAttached && tm4Port.cameraAttached,
    );
    assert.deepEqual(errors, []);
    console.log("PASS crane release and car camera restoration");
    const healthBeforeHopper = (await state()).carHealth;
    assert.equal(await page.evaluate(() => Module._WebTestEnterHopper()), 1);
    // InteractCarWithDeathPoint applies 0x800 damage on first contact;
    // it is not an unconditional kill for a healthy car.
    await page.waitForFunction(
      (health) => !tm4Port.carAlive || tm4Port.carHealth < health,
      healthBeforeHopper,
      { timeout: 5000 },
    );
    if (!(await state()).carAlive) {
      await page.waitForFunction(() => tm4Port.carAlive && tm4Port.cameraAttached, null, {
        timeout: 15000,
      });
      assert((await state()).carHealth > 0);
    }
    console.log("PASS hopper contact damage");
    await press("Enter");
    await page.waitForFunction(() => tm4Port.paused === true);
    await press("ArrowUp");
    await press("x");
    await press("ArrowUp");
    await press("x");
    await screen("main");
    assert((await state()).craneRemoved > session);
  }
  assert.deepEqual(errors, []);
  console.log("PASS crane input, camera, rotation, magnet, release and session reload");
} catch (e) {
  console.error("STATE", await state(), "ERRORS", errors);
  throw e;
} finally {
  await browser.close();
}
