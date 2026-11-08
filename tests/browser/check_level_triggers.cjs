/* global tm4Port, Module */
/* Diagnostic placement only; normal ObjectProcess must perform the interactions. */
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
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/^\[[ID]\]/.test(m.text())) errors.push(m.text());
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
    for (const map of ["Construction Yard", "Neon City", "Road Rage"]) {
      await press("x");
      await screen("newgame");
      if ((await state()).gameType !== 1) await press("ArrowRight");
      await press("x");
      await screen("dmatch");
      for (let i = 0; i < 32 && (await state()).selectedWorld !== map; ++i)
        await press("ArrowRight");
      assert.equal((await state()).selectedWorld, map);
      await press("x");
      await screen("carsel");
      await press("x");
      await page.waitForFunction(
        () => tm4Port.screen === "level" && tm4Port.levelFrames > 30,
        null,
        { timeout: 30000 },
      );
      if (map !== "Road Rage") {
        assert((await state()).teleporterInstances > 0);
        const before = await state();
        assert.equal(await page.evaluate(() => Module._WebTestApproachLevelTrigger(0, 0)), 1);
        await page.waitForFunction(
          (n) => tm4Port.teleporterDraws > n,
          before.teleporterDraws || 0,
          { timeout: 5000 },
        );
        await page.screenshot({ path: `build/checks/teleporter-${map.replaceAll(" ", "-")}.png` });
        const teleports = (await state()).teleports || 0;
        assert.equal(await page.evaluate(() => Module._WebTestApproachLevelTrigger(0, 1)), 1);
        await page.waitForFunction(
          (n) => tm4Port.teleports > n && tm4Port.lastTeleport.player,
          teleports,
          { timeout: 5000 },
        );
        const moved = await state();
        assert.deepEqual(moved.lastTeleport.transformOrigin, moved.testTeleportDestination);
        assert.deepEqual(moved.lastTeleport.destination, moved.testTeleportDestination);
        assert.equal(moved.lastTeleport.cameraSnap, 1);
        console.log("PASS teleporter", map, moved.lastTeleport);
      }
      const moved = await state();
      if (map === "Neon City") {
        assert(moved.jumppadInstances > 0);
        assert.equal(await page.evaluate(() => Module._WebTestApproachLevelTrigger(1, 1)), 1);
        const placed = await state();
        await page.waitForFunction((n) => tm4Port.jumppadLaunches > n, moved.jumppadLaunches || 0, {
          timeout: 5000,
        });
        assert((await state()).lastJumppadForce.some((v) => v !== 0));
        await page.waitForFunction((y) => tm4Port.carY < y - 100, placed.testTriggerPosition[1], {
          timeout: 5000,
        });
        console.log("PASS jumppad impulse and flight", (await state()).lastJumppadForce);
      }
      if (map === "Road Rage") {
        const initial = await state();
        assert.equal(await page.evaluate(() => Module._WebTestApproachLevelTrigger(1, -1)), 1);
        assert.equal((await state()).testJumppadOneWay, 1);
        await page.waitForFunction(
          (n) => tm4Port.playerJumppadContacts > n,
          initial.playerJumppadContacts || 0,
          { timeout: 5000 },
        );
        const rejected = await state();
        assert(rejected.lastJumppadTravelDot <= 0);
        assert.equal(rejected.playerJumppadLaunches || 0, initial.playerJumppadLaunches || 0);
        assert.equal(await page.evaluate(() => Module._WebTestApproachLevelTrigger(1, 1)), 1);
        await page.waitForFunction(
          (n) => tm4Port.playerJumppadLaunches > n,
          initial.playerJumppadLaunches || 0,
          { timeout: 5000 },
        );
        assert((await state()).lastJumppadTravelDot > 0);
        console.log("PASS one-way boost rejects reverse travel and accepts forward travel");
      }
      await press("Enter");
      await page.waitForFunction(() => tm4Port.paused === true);
      await press("ArrowUp");
      await press("x");
      await press("ArrowUp");
      await press("x");
      await screen("main");
      assert.deepEqual(errors, []);
    }
    console.log("PASS level triggers and session cleanup");
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
