import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
/* global tm4Port, Module */
import { startDiagnosticGame } from "./helpers/player.mjs";
const contacts = process.env.TM4_TEST_CONTACTS === "1";
const levelOnly = process.env.TM4_TEST_LEVEL_ONLY === "1";

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
const startGame = async () => {
  await press("x");
  await screen("newgame");
  if (levelOnly) await press("ArrowRight");
  await press("x");
  if (levelOnly) {
    await screen("dmatch");
    await press("ArrowRight");
    await press("ArrowRight");
    await press("x");
  }
  await screen("carsel");
  for (let i = 0; i < 30 && (await state()).selectedCar !== "Meter Maid"; ++i)
    await press("ArrowRight");
  assert.equal((await state()).selectedCar, "Meter Maid");
  await press("x");
  await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30, null, {
    timeout: 30000,
  });
};
try {
  await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
  await startDiagnosticGame(page);
  await screen("main");
  await page.locator("canvas").click();
  await startGame();
  for (let session = 0; session < (levelOnly ? 0 : 2); ++session) {
    const health = contacts ? await page.evaluate(() => Module._WebTestPlaceWeaponTarget(500)) : 0;
    if (contacts) assert(health > 0);
    const before = await state();
    assert.equal(before.carSelectedWeapon, 0);
    await press("w");
    await page.waitForFunction(
      (before) =>
        tm4Port.lightningEmitters > (before.lightningEmitters || 0) &&
        tm4Port.lightningBolts > (before.lightningBolts || 0) &&
        tm4Port.lightningDraws > (before.lightningDraws || 0),
      before,
      { timeout: 15000 },
    );
    assert((await state()).weaponAmmo < before.weaponAmmo);
    assert((await state()).lightSpawns > (before.lightSpawns || 0));
    await page.waitForFunction((n) => tm4Port.lightCarUpdates > n, before.lightCarUpdates || 0);
    if (contacts) {
      await page.waitForFunction((n) => tm4Port.lightningDamage > n, before.lightningDamage || 0, {
        timeout: 10000,
      });
      assert((await page.evaluate(() => Module._WebTestWeaponTargetHealth())) < health);
    }
    await page.screenshot({ path: `build/checks/lightning-${session}.png` });
    await page.waitForFunction((n) => tm4Port.lightningRemoved > n, before.lightningRemoved || 0, {
      timeout: 20000,
    });
    if (session === 0) {
      await press("w");
      await press("Enter");
      await page.waitForFunction(() => tm4Port.paused === true);
      await press("ArrowUp");
      await press("x");
      await press("ArrowUp");
      await press("x");
      await screen("main");
      await startGame();
    }
  }
  if (levelOnly) {
    assert(contacts, "Level setup requires the diagnostic build");
    assert.equal((await state()).level, "Road Rage");
    const slot = await page.evaluate(() => Module._WebTestPrepareLevelLightning());
    assert(slot >= 0, `The selected map must provide lightning positions and inventory (${slot})`);
    for (let i = 0; i < 24 && (await state()).carSelectedWeapon !== slot; ++i) await press("r");
    assert.equal((await state()).carSelectedWeapon, slot);
    const before = await state();
    const health = await page.evaluate(() => Module._WebTestWeaponTargetHealth());
    await press("w");
    await page.waitForFunction(
      (before) =>
        tm4Port.lightningEmitters > (before.lightningEmitters || 0) &&
        tm4Port.lightningFlashes > (before.lightningFlashes || 0),
      before,
      { timeout: 10000 },
    );
    assert((await state()).weaponAmmo < before.weaponAmmo);
    await page.waitForFunction((n) => tm4Port.lightningDamage > n, before.lightningDamage || 0, {
      timeout: 10000,
    });
    assert.equal(
      (await state()).lightningEmitters - (before.lightningEmitters || 0),
      before.testLightningPointCount,
    );
    assert((await page.evaluate(() => Module._WebTestWeaponTargetHealth())) < health);
    await page.screenshot({ path: "build/checks/level-lightning.png" });
    await page.waitForFunction(
      (before) =>
        tm4Port.lightningRemoved - (before.lightningRemoved || 0) >= before.testLightningPointCount,
      before,
      { timeout: 30000 },
    );
    assert.equal((await state()).lightningFlashActive, false);
    console.log("PASS level lightning: map emitters, screen flash and actual damage");
  }
  assert.deepEqual(errors, []);
  if (!levelOnly)
    console.log("PASS Meter Maid lightning: original firing, drawing, expiry and reload", {
      contacts,
    });
} catch (e) {
  console.log("STATE", await state());
  throw e;
} finally {
  await browser.close();
}
