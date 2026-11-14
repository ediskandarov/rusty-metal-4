import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
/* global tm4Port, scalePresentation */
import { setPanelOpen, startDiagnosticGame } from "./helpers/player.mjs";

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 720 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    const blit = WebGL2RenderingContext.prototype.blitFramebuffer;
    WebGL2RenderingContext.prototype.blitFramebuffer = function (...args) {
      const result = blit.apply(this, args);
      if (this.getParameter(this.DRAW_FRAMEBUFFER_BINDING) === null) {
        globalThis.scalePresentation = {
          source: [Math.abs(args[2] - args[0]), Math.abs(args[3] - args[1])],
          destination: args.slice(4, 8),
          buffer: [this.drawingBufferWidth, this.drawingBufferHeight],
        };
        const error = this.getError();
        if (error) (globalThis.scaleGlErrors ||= []).push(error);
      }
      return result;
    };
  });
  await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
  await startDiagnosticGame(page);
  await page.waitForFunction(() => tm4Port.renderScale === 8);
  assert.deepEqual(await page.evaluate(() => scalePresentation.buffer), [1200, 720]);
  const checkScale = async (label) => {
    await setPanelOpen(page, "render-settings", true);
    let original;
    for (const scale of [1, 2, 3, 4, 5, 6, 7, 8, 1, 2]) {
      const before = await page.evaluate(() =>
        tm4Port.screen === "level" ? tm4Port.levelFrames : tm4Port.frames,
      );
      await page.selectOption("#render-scale", String(scale));
      await page.waitForFunction(
        ([scale, before]) =>
          tm4Port.renderScale === scale &&
          (tm4Port.screen === "level" ? tm4Port.levelFrames : tm4Port.frames) > before + 3,
        [scale, before],
      );
      const actual = await page.evaluate(() => scalePresentation);
      if (!original) original = actual;
      assert.deepEqual(actual.destination, original.destination);
      assert.deepEqual(actual.buffer, original.buffer);
      assert.deepEqual(
        actual.source,
        original.source.map((n) => n * scale),
      );
      assert.deepEqual(await page.locator("canvas").boundingBox(), {
        x: 0,
        y: 0,
        width: 1200,
        height: 720,
      });
      console.log("PASS internal rendering scale", label, scale, actual);
      await page.screenshot({ path: `build/checks/scale-${label}-${scale}.png` });
    }
    await setPanelOpen(page, "render-settings", false);
    await page.locator("canvas").focus();
  };
  await checkScale("menu");
  const press = async (key) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
    await page.waitForTimeout(300);
  };
  const screen = (name) =>
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  await press("x");
  await screen("newgame");
  await press("x");
  await screen("carsel");
  await press("x");
  await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30, null, {
    timeout: 30000,
  });
  await checkScale("game");
  for (const width of [1400, 600, 960]) {
    await page.setViewportSize({ width, height: 720 });
    await page.waitForFunction((width) => scalePresentation.buffer[0] === width, width);
    assert.deepEqual(await page.locator("canvas").boundingBox(), {
      x: 0,
      y: 0,
      width,
      height: 720,
    });
  }
  assert.deepEqual(await page.evaluate(() => globalThis.scaleGlErrors || []), []);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
