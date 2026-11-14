import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
/* global tm4Port, Module */
import { startDiagnosticGame } from "./helpers/player.mjs";
const contacts = process.env.TM4_TEST_CONTACTS === "1";
const cases = [
  { car: "Gen. Warthog", target: true, ray: "tank" },
  { car: "Microblast", projectile: "Shorty", repeat: true },
  { car: "The Joneses", projectile: "Psycho3" },
  { car: "Mr. Zombie", projectile: "Skull", lightning: true },
  { car: "Quatro", wave: "quatro", distance: 500 },
  { car: "Orbital", projectile: "Teleorb", animation: true, lightning: true },
  { car: "Calypso", projectile: "Nuke", nuke: true, distance: 1000 },
  { car: "Capt. Grimm", projectile: "Cannon", animation: true, distance: 1500 },
  { car: "Minion", projectile: "Freeze", unlock: true, burst: { Serpent: 2, Freeze: 1 } },
  {
    car: "Sweet Tooth",
    projectile: "Hench3",
    unlock: true,
    animation: true,
    burst: { Hench1: 1, Hench2: 1, Hench3: 1 },
  },
];

const browser = await launchBrowser();
try {
  const selected = cases.filter(
    (test) => !process.env.TM4_TEST_CAR || test.car === process.env.TM4_TEST_CAR,
  );
  assert(selected.length, "Unknown requested test car");
  for (const test of selected) {
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
      page.waitForFunction(
        (name) => globalThis.tm4Port?.screen === name && tm4Port.menuReady,
        name,
        { timeout: 30000 },
      );
    try {
      await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
      await startDiagnosticGame(page);
      await screen("main");
      await page.locator("canvas").click();
      if (test.unlock) {
        await press("ArrowUp");
        await press("x");
        await screen("options");
        await press("ArrowDown");
        await press("ArrowDown");
        await press("x");
        await screen("password");
        for (const key of ["s", "ArrowRight", "ArrowUp", "ArrowLeft", "q"]) await press(key);
        await screen("options");
        await press("s");
        await screen("main");
        await press("ArrowDown");
      }
      for (let session = 0; session < 2; ++session) {
        await press("x");
        await screen("newgame");
        await press("x");
        await screen("carsel");
        for (let i = 0; i < 30 && (await state()).selectedCar !== test.car; ++i)
          await press("ArrowRight");
        assert.equal((await state()).selectedCar, test.car);
        await press("x");
        await page.waitForFunction(
          () => tm4Port.screen === "level" && tm4Port.levelFrames > 30,
          null,
          { timeout: 30000 },
        );
        let health = contacts
          ? await page.evaluate(
              (test) =>
                test.wave
                  ? Module._WebTestPlaceRadialWeaponTarget(test.distance)
                  : Module._WebTestPlaceWeaponTarget(test.distance || 500),
              test,
            )
          : 0;
        if (contacts) {
          assert(health > 0);
          await page.waitForTimeout(1000);
          health = await page.evaluate(() => Module._WebTestWeaponTargetHealth());
        }
        const before = await state();
        assert(before.weaponAmmo > 0);
        await press("w");
        await page.waitForFunction(
          ({ before, test }) =>
            test.target
              ? tm4Port.weaponAmmo < before.weaponAmmo
              : test.wave
                ? tm4Port.lastShockwave === test.wave &&
                  tm4Port.shockwaveSpawns > (before.shockwaveSpawns || 0) &&
                  tm4Port.shockwaveDraws > (before.shockwaveDraws || 0)
                : tm4Port.lastProjectile === test.projectile &&
                  tm4Port.projectileSpawns > (before.projectileSpawns || 0),
          { before, test },
          { timeout: 5000 },
        );
        if (test.repeat) assert((await state()).weaponAmmo < before.weaponAmmo);
        else assert.equal((await state()).weaponAmmo, before.weaponAmmo - 1);
        if (test.burst) {
          const fired = await state();
          for (const [name, count] of Object.entries(test.burst))
            assert.equal(
              (fired.playerProjectileSpawns?.[name] || 0) -
                (before.playerProjectileSpawns?.[name] || 0),
              count,
              name,
            );
          assert(fired.projectileDraws > (before.projectileDraws || 0));
        }
        if (test.animation) {
          await page.waitForFunction(
            (before) =>
              tm4Port.animSpawns > (before.animSpawns || 0) &&
              tm4Port.animDraws > (before.animDraws || 0),
            before,
            { timeout: 5000 },
          );
        }
        if (test.lightning)
          assert((await state()).lightningEmitters > (before.lightningEmitters || 0));
        await page.screenshot({
          path: `build/checks/special-${test.projectile || test.wave || test.ray}-${session}.png`,
        });
        if (test.target || (test.nuke && (contacts || session === 1))) {
          await page.waitForTimeout(200);
          await press("w");
          assert.equal((await state()).weaponAmmo, before.weaponAmmo - 1);
        }
        if (test.target) {
          await page.waitForFunction(
            (before) =>
              tm4Port.lastRay === "tank" &&
              tm4Port.raySpawns > (before.raySpawns || 0) &&
              tm4Port.rayDraws > (before.rayDraws || 0),
            before,
            { timeout: 5000 },
          );
        }
        if (contacts) {
          await page.waitForFunction(
            (health) => Module._WebTestWeaponTargetHealth() < health,
            health,
            { timeout: 10000 },
          );
          console.log(
            "PASS special contact",
            test.car,
            health,
            await page.evaluate(() => Module._WebTestWeaponTargetHealth()),
          );
        }
        await page.waitForFunction(
          ({ before, test }) =>
            test.target
              ? tm4Port.rayRemoved > (before.rayRemoved || 0)
              : test.wave
                ? tm4Port.shockwaveRemoved > (before.shockwaveRemoved || 0)
                : tm4Port.projectileRemoved > (before.projectileRemoved || 0),
          { before, test },
          { timeout: 20000 },
        );
        if (test.burst) {
          await page.waitForFunction(
            ({ before, burst }) =>
              Object.entries(burst).every(
                ([name, count]) =>
                  (tm4Port.playerProjectileRemoved?.[name] || 0) -
                    (before.playerProjectileRemoved?.[name] || 0) >=
                  count,
              ),
            { before, burst: test.burst },
            { timeout: 30000 },
          );
        }
        if (test.nuke) {
          await page.waitForFunction(
            (before) =>
              tm4Port.lastRay === "nuke" &&
              tm4Port.raySpawns > (before.raySpawns || 0) &&
              tm4Port.timerSpawns >= (before.timerSpawns || 0) + 7,
            before,
            { timeout: 10000 },
          );
          await page.screenshot({ path: `build/checks/special-Nuke-blast-${session}.png` });
          await page.waitForTimeout(2000);
        }
        assert.deepEqual(errors, []);
        console.log("PASS special lifecycle", test.car, session);
        await press("Enter");
        await page.waitForFunction(() => tm4Port.paused === true);
        await press("ArrowUp");
        await press("x");
        await press("ArrowUp");
        await press("x");
        await screen("main");
      }
    } catch (e) {
      console.error("FAILED", test, await state());
      throw e;
    } finally {
      await page.close();
    }
  }
  console.log("PASS original special attacks, effects, ammo, removal and session reload");
} finally {
  await browser.close();
}
