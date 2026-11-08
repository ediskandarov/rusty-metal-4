/* global tm4Port, Module */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const contacts = process.env.TM4_TEST_CONTACTS === "1";
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
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
  const checkExports = async (expected) => {
    const modules = await page.evaluate(() => {
      if (!Module._WebTestReadNativeModules) return null;
      Module._WebTestReadNativeModules();
      return tm4Port.nativeModules;
    });
    if (modules) {
      assert.equal(modules.auger, expected);
      assert.equal(modules.augerConstructor, expected);
      assert.equal(modules.weaponConstructor, modules.weapon);
    }
  };
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
    await require("./browser_startup.cjs")(page);
    await screen("main");
    await checkExports(false);
    await page.locator("canvas").click();
    // Unlock the boss through the original password screen, also in release checks.
    await press("ArrowUp");
    await press("x");
    await screen("options");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("x");
    await screen("password");
    for (const key of ["ArrowLeft", "d", "s", "ArrowRight", "ArrowDown"]) await press(key);
    await screen("options");
    await press("s");
    await screen("main");
    await press("ArrowDown");
    for (let session = 0; session < 2; ++session) {
      await press("x");
      await screen("newgame");
      await press("x");
      await screen("carsel");
      for (let i = 0; i < 30 && (await state()).selectedCar !== "Super Auger"; ++i)
        await press("ArrowRight");
      assert.equal((await state()).selectedCar, "Super Auger");
      await press("x");
      await page.waitForFunction(
        () => tm4Port.screen === "level" && tm4Port.levelFrames > 30,
        null,
        { timeout: 30000 },
      );
      await checkExports(true);
      const before = await state();
      assert(before.auger && before.auger.ticks === 0);
      assert.equal(before.carSelectedWeapon, 0);
      await press("w");
      await page.waitForFunction(
        () => tm4Port.auger?.ticks > 0 && tm4Port.auger.speed > 0 && tm4Port.auger.sound,
        null,
        { timeout: 5000 },
      );
      assert.equal((await state()).weaponAmmo, before.weaponAmmo - 1);
      if (contacts) {
        const health = await page.evaluate(() => Module._WebTestPlaceAugerTarget());
        assert(health > 0);
        await page.waitForFunction(() => tm4Port.auger.holding, null, { timeout: 5000 });
        const captured = (await state()).auger;
        await page.waitForFunction(
          (health) => tm4Port.auger.holding && tm4Port.auger.targetHealth < health,
          health,
          { timeout: 5000 },
        );
        await page.waitForFunction(
          (up) => tm4Port.auger.holding && tm4Port.auger.targetUp.some((x, i) => x !== up[i]),
          captured.targetUp,
          { timeout: 5000 },
        );
        console.log("PASS Auger captures, spins and damages target", (await state()).auger);
      }
      await page.screenshot({ path: `build/checks/auger-${session}-active.png` });
      await page.waitForFunction(
        () =>
          tm4Port.auger.ticks === 0 &&
          !tm4Port.auger.holding &&
          tm4Port.auger.speed === 0 &&
          !tm4Port.auger.sound,
        null,
        { timeout: 30000 },
      );
      console.log("PASS Auger expiry, release and sound wind-down");
      assert.deepEqual(errors, []);
      await press("Enter");
      await page.waitForFunction(() => tm4Port.paused === true);
      await press("ArrowUp");
      await press("x");
      await press("ArrowUp");
      await press("x");
      await screen("main");
      await checkExports(false);
    }
    assert.deepEqual(errors, []);
    console.log("PASS Auger special, native callbacks, ammo, lifetime and session reload");
  } catch (e) {
    console.error("STATE", await state(), "ERRORS", errors);
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
