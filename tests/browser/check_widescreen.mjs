import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { startDiagnosticGame } from "./helpers/player.mjs";

const browser = await launchBrowser();
try {
  for (const [width, height] of [
    [1280, 800],
    [1280, 720],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      screen: { width, height },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const press = async (key) => {
      await page.keyboard.press(key, { delay: 120 });
      await page.waitForTimeout(180);
    };
    const menu = (name) =>
      page.waitForFunction(
        (name) => globalThis.tm4Port.screen === name && globalThis.tm4Port.menuReady,
        name,
        { timeout: 30000 },
      );
    const wide = () => page.evaluate(() => !!globalThis.tm4Port.widescreen);
    const fullscreen = async () => {
      await page.locator("canvas").dblclick();
      await page.waitForFunction(() => !!document.fullscreenElement);
    };
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8376/");
    await startDiagnosticGame(page);
    await fullscreen();
    assert.equal(await wide(), false, "fullscreen menu stays 4:3");
    await page.screenshot({ path: `build/checks/fullscreen-menu-${height}.png` });
    await press("Escape");
    await page.waitForFunction(() => !document.fullscreenElement);
    await press("x");
    await menu("newgame");
    await press("x");
    await menu("carsel");
    await press("x");
    await page.waitForFunction(() => globalThis.tm4Port.levelFrames > 30, null, { timeout: 60000 });
    assert.equal(await wide(), false, "windowed battle stays 4:3");
    await page.screenshot({ path: `build/checks/windowed-battle-${height}.png` });
    await fullscreen();
    await page.waitForFunction(() => globalThis.tm4Port.widescreen);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `build/checks/fullscreen-battle-${height}.png` });
    await press("Escape");
    await page.waitForFunction(() => !document.fullscreenElement && !globalThis.tm4Port.widescreen);
    assert(
      !(await page.evaluate(() => globalThis.tm4Port.paused)),
      "exiting fullscreen does not pause",
    );
    await fullscreen();
    await page.waitForFunction(() => globalThis.tm4Port.widescreen);
    await page.keyboard.down("x");
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(2500);
    await page.keyboard.up("ArrowRight");
    await page.keyboard.up("x");
    await press("Enter");
    await page.waitForFunction(() => globalThis.tm4Port.paused);
    await page.screenshot({ path: `build/checks/fullscreen-pause-${height}.png` });
    await press("ArrowUp");
    await press("x");
    await press("ArrowUp");
    await press("x");
    await menu("main");
    assert.equal(await wide(), false, "returning to menu restores 4:3 without leaving fullscreen");
    assert(await page.evaluate(() => !!document.fullscreenElement));
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}x${height}: windowed 4:3, fullscreen battle, Escape, pause, fullscreen menu 4:3`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
