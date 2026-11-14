/* global tm4Port */
/* Original password, map selection and driving; no diagnostic hooks. */
const { startDiagnosticGame } = require("./helpers/player.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  await require("./browser_diagnostics.cjs")(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
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
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  const nextMap = async () => {
    const previous = (await state()).selectedWorld;
    await page.keyboard.down("ArrowRight");
    try {
      await page.waitForFunction((previous) => tm4Port.selectedWorld !== previous, previous, {
        timeout: 10000,
      });
    } finally {
      await page.keyboard.up("ArrowRight");
    }
    await screen("dmatch");
    await page.waitForTimeout(100);
  };
  const chooseDeathmatch = async () => {
    await press("x");
    await screen("newgame");
    if ((await state()).gameType !== 1) await press("ArrowRight");
    await press("x");
    await screen("dmatch");
  };
  try {
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await startDiagnosticGame(page);
    await screen("main");
    await page.locator("canvas").click();
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
    await chooseDeathmatch();
    const maps = [];
    for (let i = 0; i < 32; ++i) {
      const map = (await state()).selectedWorld;
      if (maps.includes(map)) break;
      maps.push(map);
      await nextMap();
    }
    assert.equal(maps.length, 16, "all original maps must be selectable after the password");
    console.log("MAPS", maps);
    for (let i = 0; i < maps.length; ++i) {
      if (i) await chooseDeathmatch();
      for (let j = 0; j < 16 && (await state()).selectedWorld !== maps[i]; ++j) await nextMap();
      assert.equal((await state()).selectedWorld, maps[i]);
      await press("x");
      await screen("carsel");
      await press("x");
      await page.waitForFunction(
        () => tm4Port.screen === "level" && tm4Port.levelFrames > 30,
        null,
        { timeout: 45000 },
      );
      if (process.env.TM4_TEST_CALLBACK_TYPES) await require("./check_object_callbacks.cjs")(page);
      const before = await state();
      assert.equal(before.level, maps[i]);
      assert(before.vertices > 0 && before.faces > 0 && before.collisionFaces > 0);
      assert(before.carAlive && before.cameraAttached);
      assert(before.cars.length > 1);
      await page.keyboard.down("x");
      try {
        await page.waitForFunction(
          (before) => {
            const s = tm4Port;
            return (
              s.carTicks > before.carTicks + 30 &&
              s.carContact !== 0 &&
              Math.hypot(s.carX - before.carX, s.carZ - before.carZ) > 100
            );
          },
          before,
          { timeout: 15000 },
        );
      } finally {
        await page.keyboard.up("x");
      }
      const after = await state();
      assert(after.levelFrames > before.levelFrames);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `build/checks/map-${i}.png` });
      console.log("PASS", maps[i], {
        vertices: after.vertices,
        faces: after.faces,
        collision: after.collisionFaces,
        cars: after.cars.length,
        movement: Math.round(Math.hypot(after.carX - before.carX, after.carZ - before.carZ)),
      });
      await press("Enter");
      await page.waitForFunction(() => tm4Port.paused === true);
      await press("ArrowUp");
      await press("x");
      await press("ArrowUp");
      await press("x");
      await screen("main");
    }
    assert.deepEqual(errors, []);
    console.log("PASS all 16 maps: original loading, driving, collision and return to menu");
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
