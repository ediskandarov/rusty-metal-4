/* global tm4Port, Module */
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
    await require("./browser_startup.cjs")(page);
    await screen("main");
    await page.locator("canvas").click();
    await page.evaluate(() => Module._WebTestReadNativeModules());
    assert.equal((await state()).nativeModules.car, false);
    assert.equal((await state()).nativeModules.crusher, false);
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
    for (let session = 0; session < 2; ++session)
      for (const name of ["slam", "trash", "crusher"]) {
        if (process.env.TM4_TEST_CAR && process.env.TM4_TEST_CAR !== name) continue;
        await press("x");
        await screen("newgame");
        await press("x");
        await screen("carsel");
        for (let i = 0; i < 32 && !(await state()).selectedCar.toLowerCase().includes(name); ++i)
          await press("ArrowRight");
        assert((await state()).selectedCar.toLowerCase().includes(name));
        await press("x");
        await page.waitForFunction(
          () => tm4Port.screen === "level" && tm4Port.levelFrames > 30,
          null,
          { timeout: 30000 },
        );
        await page.evaluate(() => Module._WebTestReadNativeModules());
        assert.equal((await state()).nativeModules.car, true);
        if (name === "crusher") assert.equal((await state()).nativeModules.crusher, true);
        assert.equal(await page.evaluate(() => Module._WebTestReadCarGrab()), 1);
        assert.equal((await state()).carGrab.remaining, 0);
        const ammo = (await state()).weaponAmmo;
        await press("w");
        await page.waitForFunction(
          () => {
            Module._WebTestReadCarGrab();
            return tm4Port.carGrab.remaining > 0;
          },
          null,
          { timeout: 5000 },
        );
        assert.equal((await state()).weaponAmmo, ammo - 1);
        const health = await page.evaluate(() => Module._WebTestPlaceAugerTarget());
        assert(health > 0);
        await page.waitForFunction(
          () => {
            Module._WebTestReadCarGrab();
            return tm4Port.carGrab.holding;
          },
          null,
          { timeout: 5000 },
        );
        const captured = (await state()).carGrab;
        assert(captured.sound);
        await page.waitForFunction(
          (before) => {
            Module._WebTestReadCarGrab();
            const g = tm4Port.carGrab;
            return (
              g.holding &&
              g.angle !== before.angle &&
              g.position.some((x, i) => x !== before.position[i])
            );
          },
          captured,
          { timeout: 5000 },
        );
        await page.waitForFunction(
          (health) => {
            Module._WebTestReadCarGrab();
            return tm4Port.carGrab.holding && tm4Port.carGrab.health < health;
          },
          captured.health,
          { timeout: 15000 },
        );
        console.log(
          "PASS capture, motion, damage",
          name,
          session,
          captured,
          (await state()).carGrab,
        );
        await page.screenshot({ path: `build/checks/car-grab-${name}-${session}.png` });
        await page.waitForFunction(
          () => {
            Module._WebTestReadCarGrab();
            const g = tm4Port.carGrab;
            return g.remaining === 0 && !g.holding && !g.sound;
          },
          null,
          { timeout: 30000 },
        );
        assert.deepEqual(errors, []);
        await press("Enter");
        await page.waitForFunction(() => tm4Port.paused === true);
        await press("ArrowUp");
        await press("x");
        await press("ArrowUp");
        await press("x");
        await screen("main");
        await page.evaluate(() => Module._WebTestReadNativeModules());
        assert.equal((await state()).nativeModules.car, false);
        assert.equal((await state()).nativeModules.crusher, false);
        console.log("PASS expiry, release and teardown", name, session);
      }
    assert.deepEqual(errors, []);
    console.log(
      "PASS original shovel/pincher attacks, collision capture, damage and session reload",
    );
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
