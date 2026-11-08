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
    for (let session = 0; session < 2; ++session) {
      const before = await state();
      await press("x");
      await screen("newgame");
      if ((await state()).gameType !== 1) await press("ArrowRight");
      await press("x");
      await screen("dmatch");
      for (let i = 0; i < 32 && (await state()).selectedWorld !== "Neon City"; ++i)
        await press("ArrowRight");
      assert.equal((await state()).selectedWorld, "Neon City");
      await press("x");
      await screen("carsel");
      await press("x");
      await page.waitForFunction(
        () => tm4Port.screen === "level" && tm4Port.levelFrames > 30,
        null,
        { timeout: 30000 },
      );
      const loaded = await state();
      assert(loaded.trainInstances > (before.trainInstances || 0));
      assert(loaded.ufoInstances > (before.ufoInstances || 0));
      await page.waitForTimeout(3000);
      const moved = await state();
      assert.notDeepEqual(moved.trainPosition, loaded.trainPosition);
      assert.notDeepEqual(moved.ufoPosition, loaded.ufoPosition);
      console.log("MOVEMENT", session, {
        train: moved.trainPosition,
        ufo: moved.ufoPosition,
        trainDraws: moved.trainDraws,
        ufoDraws: moved.ufoDraws,
      });
      assert.equal(await page.evaluate(() => Module._WebTestApproachNeonObject(0)), 1);
      await page.waitForFunction((n) => tm4Port.trainPlayerHits > n, moved.trainPlayerHits || 0, {
        timeout: 20000,
      });
      assert.equal(await page.evaluate(() => Module._WebTestApproachNeonObject(1)), 1);
      await page.waitForFunction((n) => tm4Port.ufoCaptures > n, moved.ufoCaptures || 0, {
        timeout: 120000,
      });
      assert.equal((await state()).ufoCapturedPlayer, true);
      await page.waitForTimeout(1000);
      console.log("CAPTURE", (await state()).ufoPosition, (await state()).carY);
      await page.screenshot({ path: `build/checks/neon-${session}.png` });
      await page.waitForFunction((n) => tm4Port.ufoReleases > n, moved.ufoReleases || 0, {
        timeout: 120000,
      });
      const released = await state();
      const { position, drop, radius } = released.ufoRelease;
      assert(Math.hypot(position[0] - drop[0], position[2] - drop[2]) <= radius + 1);
      assert(drop[1] >= position[1]);
      assert(released.ufoDraws > (before.ufoDraws || 0));
      assert(released.trainDraws > (before.trainDraws || 0));
      console.log("PASS train collision and UFO capture/dropoff", session, released.ufoRelease);
      await press("Enter");
      await page.waitForFunction(() => tm4Port.paused === true);
      await press("ArrowUp");
      await press("x");
      await press("ArrowUp");
      await press("x");
      await screen("main");
      const ended = await state();
      assert.equal(ended.trainRemoved || 0, ended.trainInstances);
      assert.equal(ended.ufoRemoved || 0, ended.ufoInstances);
      assert.deepEqual(errors, []);
      console.log("PASS Neon City movement and cleanup", session);
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
