/* global tm4Port */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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
    if (m.type() === "error" && !/^\[[ID]\]/.test(m.text())) errors.push(m.text());
  });
  await require("./browser_diagnostics.cjs")(page);
  const press = async (key) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
    await page.waitForTimeout(150);
  };
  const screen = async (name) =>
    page.waitForFunction((name) => globalThis.tm4Port?.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  try {
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await require("./browser_startup.cjs")(page);
    await screen("main");
    await page.locator("canvas").click();
    assert.deepEqual(await page.evaluate(() => tm4Port.loadingHistory), ["LEGAL.TIM"]);
    await require("./check_menu_highlight.cjs")(page, "build/checks/menu-startup");
    await press("x");
    await screen("newgame");
    await press("x");
    await screen("carsel");
    await press("x");
    await page.waitForFunction(() => tm4Port.carTicks > 30, null, { timeout: 30000 });
    await press("Enter");
    await page.waitForFunction(() => tm4Port.paused === true, null, { timeout: 10000 });
    const paused = await page.evaluate(() => tm4Port.carTicks);
    await page.waitForTimeout(900);
    assert.equal(
      await page.evaluate(() => tm4Port.carTicks),
      paused,
      "simulation must stop during pause",
    );
    await page.screenshot({ path: "build/checks/pause-options.png" });
    await press("ArrowDown");
    await press("x");
    await press("ArrowDown");
    await page.screenshot({ path: "build/checks/pause-camera.png" });
    await press("x");
    await press("ArrowUp");
    await press("x");
    await page.waitForFunction((ticks) => !tm4Port.paused && tm4Port.carTicks > ticks, paused, {
      timeout: 10000,
    });
    await press("Enter");
    await page.waitForFunction(() => tm4Port.paused === true);
    await press("ArrowUp");
    await press("x");
    await press("ArrowUp");
    await press("x");
    await screen("main");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "build/checks/pause-return-menu.png" });
    await require("./check_menu_highlight.cjs")(page, "build/checks/menu-return");
    await press("x");
    await screen("newgame");
    await press("x");
    await screen("carsel");
    await press("x");
    await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30, null, {
      timeout: 30000,
    });
    assert.deepEqual(
      await page.evaluate(() => tm4Port.loadingHistory.map((name) => name.toUpperCase())),
      ["LEGAL.TIM", "YARD.TIM", "TITLE.TIM", "YARD.TIM"],
    );
    if (process.env.TM4_TEST_OVERLAY_RELOAD) {
      const generations = await page.evaluate(() => tm4Port.carSearchGenerationsAtLoad);
      console.log("AI search generations at module load", generations);
      assert.deepEqual(
        generations,
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        "reloading o_car must restore its initial search-generation state",
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS original pause freezes simulation, changes camera, resumes, quits and starts a second match",
    );
  } catch (e) {
    console.log("FAIL STATE", await page.evaluate(() => tm4Port));
    await page.screenshot({ path: "build/checks/pause-failure.png" });
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
