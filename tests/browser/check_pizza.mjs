import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
/* global tm4Port, Module */
import { startDiagnosticGame } from "./helpers/player.mjs";
const contacts = process.env.TM4_TEST_CONTACTS === "1";

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
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
    for (let i = 0; i < 30 && (await state()).selectedCar !== "Pizza Boy"; ++i)
      await press("ArrowRight");
    assert.equal((await state()).selectedCar, "Pizza Boy");
    await press("x");
    await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30, null, {
      timeout: 30000,
    });
    const health = contacts ? await page.evaluate(() => Module._WebTestPlaceWeaponTarget(500)) : 0;
    if (contacts) assert(health > 0);
    const before = await state();
    assert.equal(before.weaponName, "Blades");
    assert(before.weaponAmmo > 0);
    await press("w");
    await page.waitForFunction(
      (before) =>
        tm4Port.lastProjectile === "Blade" &&
        tm4Port.projectileSpawns >= (before.projectileSpawns || 0) + 2 &&
        tm4Port.bladeDraws > (before.bladeDraws || 0),
      before,
      { timeout: 5000 },
    );
    assert.equal((await state()).weaponAmmo, before.weaponAmmo - 1);
    await page.screenshot({ path: `build/checks/pizza-blades-${session}.png` });
    if (contacts) {
      await page.waitForFunction((health) => Module._WebTestWeaponTargetHealth() < health, health, {
        timeout: 5000,
      });
      console.log("PASS Pizza Boy blade contact", {
        before: health,
        after: await page.evaluate(() => Module._WebTestWeaponTargetHealth()),
      });
    }
    await page.waitForFunction(
      (before) => tm4Port.projectileRemoved >= (before.projectileRemoved || 0) + 2,
      before,
      { timeout: 15000 },
    );
    assert.deepEqual(errors, []);
    await press("Enter");
    await page.waitForFunction(() => tm4Port.paused === true);
    await press("ArrowUp");
    await press("x");
    await press("ArrowUp");
    await press("x");
    await screen("main");
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS Pizza Boy: original special -> two rotating blades -> one ammo -> removal -> session reload",
  );
} catch (e) {
  console.error("STATE", await state(), "ERRORS", errors);
  throw e;
} finally {
  await browser.close();
}
