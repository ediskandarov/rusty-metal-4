/* global tm4Port, Module */
const { startDiagnosticGame } = require("./helpers/player.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/^\[[ID]\]/.test(m.text())) errors.push(m.text());
  });
  await require("./browser_diagnostics.cjs")(page);
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
    for (const map of ["oil", "carn", "oil", "carn"]) {
      const before = await state();
      await press("x");
      await screen("newgame");
      if ((await state()).gameType !== 1) await press("ArrowRight");
      await press("x");
      await screen("dmatch");
      for (let i = 0; i < 32 && !(await state()).selectedWorld.toLowerCase().includes(map); ++i)
        await press("ArrowRight");
      assert((await state()).selectedWorld.toLowerCase().includes(map));
      await press("x");
      await screen("carsel");
      await press("x");
      await page.waitForFunction(
        () => tm4Port.screen === "level" && tm4Port.levelFrames > 30,
        null,
        { timeout: 30000 },
      );
      const loaded = await state();
      console.log("LOADED", map, loaded.selectedWorld, {
        coaster: loaded.coasterInstances,
        helicopter: loaded.helicopterInstances,
      });
      await page.waitForTimeout(2300);
      const moved = await state();
      if (map === "carn") {
        assert(loaded.coasterInstances > (before.coasterInstances || 0));
        assert.notDeepEqual(moved.coasterPosition, loaded.coasterPosition);
        assert.equal(await page.evaluate(() => Module._WebTestApproachPathObject(0)), 1);
        await page.waitForFunction(
          (n) => tm4Port.coasterPlayerHits > n,
          moved.coasterPlayerHits || 0,
          { timeout: 30000 },
        );
        await page.waitForFunction((n) => tm4Port.coasterDraws > n, before.coasterDraws || 0, {
          timeout: 15000,
        });
        console.log("PASS coaster movement, rendering and collision");
      } else {
        assert(loaded.helicopterInstances > (before.helicopterInstances || 0));
        assert.notDeepEqual(moved.helicopter.position, loaded.helicopter.position);
        assert.notEqual(moved.helicopter.topAngle, loaded.helicopter.topAngle);
        assert.notEqual(moved.helicopter.tailAngle, loaded.helicopter.tailAngle);
        assert.equal(await page.evaluate(() => Module._WebTestApproachPathObject(1)), 1);
        await page.waitForFunction(() => tm4Port.helicopter.pickupActive === 0, null, {
          timeout: 10000,
        });
        const picked = await state();
        console.log("PICKUP", picked.helicopter, "health", picked.carHealth);
        await page.waitForFunction((n) => tm4Port.helicopterLaps > n, picked.helicopterLaps || 0, {
          timeout: 180000,
        });
        await page.waitForFunction(
          (n) => tm4Port.helicopterDraws > n,
          before.helicopterDraws || 0,
          { timeout: 30000 },
        );
        const beforeDamage = await state();
        assert.equal(await page.evaluate(() => Module._WebTestLaunchAtHelicopter()), 1);
        await page.waitForFunction(
          (before) =>
            tm4Port.helicopterRemoved === (before.helicopterRemoved || 0) + 1 &&
            tm4Port.pickupInstances === before.pickupInstances + 5 &&
            tm4Port.levelFrames > before.levelFrames + 30,
          beforeDamage,
          { timeout: 10000 },
        );
        const destroyed = await state();
        assert.equal(
          destroyed.playerProjectileSpawns.Power,
          (beforeDamage.playerProjectileSpawns?.Power || 0) + 1,
        );
        assert.equal(destroyed.helicopterInstances, beforeDamage.helicopterInstances);
        assert(destroyed.fragmentSpawns > (beforeDamage.fragmentSpawns || 0));
        console.log(
          "PASS helicopter route, blades, pickup, lap, Power impact and five weapon drops",
        );
      }
      await page.screenshot({ path: `build/checks/level-${map}.png` });
      await press("Enter");
      await page.waitForFunction(() => tm4Port.paused === true);
      await press("ArrowUp");
      await press("x");
      await press("ArrowUp");
      await press("x");
      await screen("main");
      const ended = await state();
      const prefix = map === "carn" ? "coaster" : "helicopter";
      assert.equal(ended[prefix + "Removed"] || 0, ended[prefix + "Instances"]);
      assert.deepEqual(errors, []);
      console.log("PASS map cleanup", map);
    }
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
