/* global tm4Port */
const { startDiagnosticGame } = require("./helpers/player.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  await require("./browser_diagnostics.cjs")(page);
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(String(error));
    console.error(error);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !/^\[[ID]\]/.test(message.text())) {
      errors.push(message.text());
      console.error(message.text());
    }
  });
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
    await press("x");
    await screen("newgame");
    await press("x");
    await screen("carsel");
    await require("./check_preview_rotation.cjs")(page);
    const initial = await page.evaluate(() => tm4Port.selectedCar);
    for (let cycle = 0; cycle < 3; ++cycle) {
      const seen = new Set();
      for (let step = 0; step < 32; ++step) {
        seen.add(await page.evaluate(() => tm4Port.selectedCar));
        const previous = await page.evaluate(() => tm4Port.selectedCar);
        await page.keyboard.down("ArrowRight");
        try {
          await page.waitForFunction((previous) => tm4Port.selectedCar !== previous, previous, {
            timeout: 10000,
          });
        } finally {
          await page.keyboard.up("ArrowRight");
        }
        await screen("carsel");
        await page.waitForTimeout(100);
        if (await page.evaluate((name) => tm4Port.selectedCar === name, initial)) break;
      }
      assert.equal(seen.size, 22, `Only ${seen.size} unlocked stock previews visited`);
      assert.equal(await page.evaluate(() => tm4Port.selectedCar), initial);
      assert.deepEqual(errors, []);
      console.log("PASS preview reload cycle", cycle, [...seen]);
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
