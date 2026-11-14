/* global startupDisplay, Module, tm4DisplayPosition, displayPixels */
const { launchBrowser } = require("./helpers/browser.cjs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await launchBrowser();
  try {
    // A resize must not be needed to initialize the drawing buffer or aspect ratio.
    for (const [width, height, deviceScaleFactor] of [
      [1200, 700, 1],
      [600, 900, 1],
      [900, 600, 2],
    ]) {
      const startup = await browser.newPage({ viewport: { width, height }, deviceScaleFactor });
      await startup.addInitScript(() => {
        const blit = WebGL2RenderingContext.prototype.blitFramebuffer;
        WebGL2RenderingContext.prototype.blitFramebuffer = function (...args) {
          const result = blit.apply(this, args);
          if (this.getParameter(this.DRAW_FRAMEBUFFER_BINDING) === null) {
            globalThis.startupDisplay = {
              buffer: [this.drawingBufferWidth, this.drawingBufferHeight],
              destination: args.slice(4, 8),
            };
          }
          return result;
        };
      });
      await startup.goto((process.env.TM4_WEB_URL || "http://127.0.0.1:8080/") + "display-check/");
      await startup.waitForFunction(() => globalThis.startupDisplay);
      const initial = await startup.evaluate(() => startupDisplay);
      assert.deepEqual(
        initial.buffer,
        [width * deviceScaleFactor, height * deviceScaleFactor],
        "initial drawing buffer must follow CSS size and device pixel ratio",
      );
      await startup.setViewportSize({ width: width + 100, height });
      await startup.waitForFunction(
        (w) => startupDisplay.buffer[0] === w,
        (width + 100) * deviceScaleFactor,
      );
      await startup.setViewportSize({ width, height });
      await startup.waitForFunction(
        (w) => startupDisplay.buffer[0] === w,
        width * deviceScaleFactor,
      );
      assert.deepEqual(
        await startup.evaluate(() => startupDisplay),
        initial,
        "initial presentation must equal presentation after resizing back",
      );
      console.log("PASS initial window size", { width, height, deviceScaleFactor }, initial);
      await startup.close();
    }
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      const blit = WebGL2RenderingContext.prototype.blitFramebuffer;
      WebGL2RenderingContext.prototype.blitFramebuffer = function (...args) {
        const result = blit.apply(this, args);
        if (this.getParameter(this.DRAW_FRAMEBUFFER_BINDING) !== null) return result;
        const w = this.drawingBufferWidth,
          h = this.drawingBufferHeight;
        const saved = this.getParameter(this.READ_FRAMEBUFFER_BINDING);
        this.bindFramebuffer(this.READ_FRAMEBUFFER, null);
        const pixels = new Uint8Array(w * h * 4);
        this.readPixels(0, 0, w, h, this.RGBA, this.UNSIGNED_BYTE, pixels);
        this.bindFramebuffer(this.READ_FRAMEBUFFER, saved);
        const red = { x: w, y: h, right: -1, bottom: -1 };
        const area = { x: w, y: h, right: -1, bottom: -1 };
        for (let y = 0; y < h; ++y)
          for (let x = 0; x < w; ++x) {
            const p = ((h - 1 - y) * w + x) * 4;
            const r = pixels[p],
              b = pixels[p + 2];
            for (const bounds of r > 200 && b < 20 ? [red, area] : b > 200 ? [area] : []) {
              bounds.x = Math.min(bounds.x, x);
              bounds.y = Math.min(bounds.y, y);
              bounds.right = Math.max(bounds.right, x);
              bounds.bottom = Math.max(bounds.bottom, y);
            }
          }
        globalThis.displayPixels = { red, area, w, h };
        return result;
      };
    });
    await page.goto((process.env.TM4_WEB_URL || "http://127.0.0.1:8080/") + "display-check/");
    await page.waitForFunction(() => globalThis.displayPixels?.red.right >= 0);
    const setPosition = async (x, y) => {
      await page.evaluate(([x, y]) => Module._WebTestScreenPosition(x, y), [x, y]);
      await page.waitForFunction(
        ([x, y]) => globalThis.tm4DisplayPosition?.[0] === x && tm4DisplayPosition[1] === y,
        [x, y],
      );
      await page.waitForTimeout(100);
      return page.evaluate(() => displayPixels);
    };
    for (const native of [0, 1]) {
      await page.evaluate((native) => Module._WebTestNativeDisplay(native), native);
      await page.waitForTimeout(200);
      const before = await page.evaluate(() => displayPixels);
      for (const [x, y] of [
        [8, 6],
        [-8, 0],
        [0, 12],
        [0, 0],
      ]) {
        const after = await setPosition(x, y);
        const dx = Math.round((x * (before.area.right - before.area.x + 1)) / 256);
        const dy = Math.round((y * (before.area.bottom - before.area.y + 1)) / 240);
        assert.equal(after.red.x, before.red.x + dx, `horizontal offset ${x}`);
        assert.equal(after.red.y, before.red.y + dy, `vertical offset ${y}`);
        assert.equal(after.red.right - after.red.x, before.red.right - before.red.x);
        assert.equal(after.red.bottom - after.red.y, before.red.bottom - before.red.y);
        assert.equal(after.area.x, before.area.x + Math.max(0, dx));
        assert.equal(after.area.y, before.area.y + Math.max(0, dy));
        assert.equal(after.area.right, before.area.right + Math.min(0, dx));
        assert.equal(after.area.bottom, before.area.bottom + Math.min(0, dy));
        console.log("PASS display position", { native, x, y }, after);
      }
      const resize = async (width, height) => {
        await page.setViewportSize({ width, height });
        await page.waitForFunction(
          ([width, height]) => displayPixels.w === width && displayPixels.h === height,
          [width, height],
        );
        const bounds = await page.locator("canvas").boundingBox();
        assert.deepEqual(bounds, { x: 0, y: 0, width, height });
        return page.evaluate(() => displayPixels);
      };
      // Establish a resized baseline, then check both layout and actual GPU output.
      await resize(800, 720);
      const baseline = await resize(960, 720);
      for (const [width, height] of [
        [1400, 720],
        [600, 720],
        [960, 720],
        [1400, 720],
        [960, 720],
        [480, 900],
        [1200, 480],
        [960, 720],
      ]) {
        const pixels = await resize(width, height);
        if (width === 960 && height === 720) assert.deepEqual(pixels, baseline);
      }
      console.log("PASS repeated window resize", { native });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
