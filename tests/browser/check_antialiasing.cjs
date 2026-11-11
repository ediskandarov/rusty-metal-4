/* global tm4Port, antialiasingProbe */
const assert = require("node:assert/strict");
const { mkdir, writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const output = resolve("build/checks/antialiasing");
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--mute-audio"],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/GL_INVALID|GL_ERROR|Antialiasing shader:|Antialiasing program:/.test(message.text()))
      errors.push(message.text());
  });
  await page.addInitScript(() => {
    globalThis.antialiasingProbe = {
      armed: false,
      draws: 0,
      result: null,
      before: null,
      intermediates: [],
    };
    const prototype = WebGL2RenderingContext.prototype;
    const copy = prototype.copyTexSubImage2D;
    const draw = prototype.drawArrays;
    const read = (gl, width, height, x = 0, y = 0) => {
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { pixels, width, height };
    };
    const png = ({ pixels, width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      const data = context.createImageData(width, height);
      // The game canvas is top-down; presentation performs the GL Y inversion.
      data.data.set(pixels);
      context.putImageData(data, 0, 0);
      return canvas.toDataURL();
    };
    prototype.copyTexSubImage2D = function (...args) {
      if (antialiasingProbe.armed) {
        antialiasingProbe.before = read(this, args[6], args[7], args[4], args[5]);
        antialiasingProbe.source = {
          framebuffer: this.getParameter(this.READ_FRAMEBUFFER_BINDING),
          x: args[4],
          y: args[5],
        };
      }
      return copy.apply(this, args);
    };
    prototype.drawArrays = function (...args) {
      const result = draw.apply(this, args);
      const program = this.getParameter(this.CURRENT_PROGRAM);
      if (!program) return result;
      const target = this.getParameter(this.DRAW_FRAMEBUFFER_BINDING);
      const frame = this.getUniformLocation(program, "frame");
      const finalPass =
        frame !== null &&
        (this.getUniformLocation(program, "blend") !== null ||
          this.getUniformLocation(program, "SMAA_RT_METRICS") === null);
      if (finalPass) antialiasingProbe.draws++;
      if (!target || !antialiasingProbe.armed || !antialiasingProbe.before) return result;
      if (frame === null && this.getUniformLocation(program, "edges") === null) return result;
      const before = antialiasingProbe.before;
      const previous = this.getParameter(this.READ_FRAMEBUFFER_BINDING);
      this.bindFramebuffer(this.READ_FRAMEBUFFER, target);
      const after = read(this, before.width, before.height);
      this.bindFramebuffer(this.READ_FRAMEBUFFER, previous);
      if (!finalPass) {
        antialiasingProbe.intermediates.push({
          image: png(after),
          nonzero: after.pixels.filter((value) => value !== 0).length,
        });
        return result;
      }
      if (antialiasingProbe.armed) {
        const source = antialiasingProbe.source;
        this.bindFramebuffer(this.READ_FRAMEBUFFER, source.framebuffer);
        const untouched = read(this, before.width, before.height, source.x, source.y);
        this.bindFramebuffer(this.READ_FRAMEBUFFER, previous);
        const sourcePreserved = before.pixels.every((value, i) => value === untouched.pixels[i]);
        let changed = 0,
          unchanged = 0;
        for (let i = 0; i < after.pixels.length; i += 4) {
          const difference =
            Math.abs(after.pixels[i] - before.pixels[i]) +
            Math.abs(after.pixels[i + 1] - before.pixels[i + 1]) +
            Math.abs(after.pixels[i + 2] - before.pixels[i + 2]);
          if (difference > 3) changed++;
          if (difference === 0) unchanged++;
        }
        antialiasingProbe.result = {
          sourcePreserved,
          before: png(before),
          intermediates: antialiasingProbe.intermediates,
          after: png(after),
          changed,
          unchanged,
          width: after.width,
          height: after.height,
          error: this.getError(),
        };
        antialiasingProbe.armed = false;
        antialiasingProbe.before = null;
      }
      return result;
    };
  });
  const screen = (name) =>
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  async function press(key) {
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
    await page.waitForTimeout(150);
  }
  async function capture(name) {
    await page.evaluate(() => {
      antialiasingProbe.result = null;
      antialiasingProbe.intermediates = [];
      antialiasingProbe.armed = true;
    });
    await page.waitForFunction(() => antialiasingProbe.result, null, { timeout: 15000 });
    const result = await page.evaluate(() => antialiasingProbe.result);
    assert(result.sourcePreserved, name + ": modified the game framebuffer");
    assert.equal(result.error, 0, `${name}: GL error`);
    assert(result.changed > 100, `${name}: no visible filtering`);
    assert(result.unchanged > (result.width * result.height) / 10, `${name}: whole image blurred`);
    if (await page.evaluate(() => tm4Port.antialiasing === 2)) {
      assert.equal(result.intermediates.length, 2, name + ": SMAA needs both intermediate passes");
      for (const [i, pass] of result.intermediates.entries()) {
        assert(pass.nonzero > 100, name + ": empty SMAA pass");
        await writeFile(
          resolve(output, name + "-pass-" + i + ".png"),
          Buffer.from(pass.image.split(",")[1], "base64"),
        );
      }
    }
    for (const side of ["before", "after"])
      await writeFile(
        resolve(output, `${name}-${side}.png`),
        Buffer.from(result[side].split(",")[1], "base64"),
      );
    console.log(
      `${name} (${result.width}×${result.height}): ${result.changed} changed, ${result.unchanged} unchanged pixels`,
    );
  }
  try {
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8174/");
    await require("./browser_startup.cjs")(page);
    assert.equal(await page.evaluate(() => tm4Port.antialiasing), 2);
    await capture("smaa-menu");
    await page.locator("#render-settings > summary").click();
    let lowSize;
    for (const scale of ["1", "2", "8"]) {
      await page.selectOption("#render-scale", scale);
      await page.waitForFunction((scale) => tm4Port.renderScale === scale, Number(scale));
      for (const [mode, label] of [
        ["1", "fxaa"],
        ["2", "smaa"],
      ]) {
        await page.selectOption("#render-antialiasing", mode);
        await page.waitForFunction((mode) => tm4Port.antialiasing === mode, Number(mode));
        await capture(label + "-scale-" + scale);
        const size = await page.evaluate(() => ({
          width: antialiasingProbe.result.width,
          height: antialiasingProbe.result.height,
        }));
        if (scale === "1") lowSize = size;
        else
          assert.deepEqual(size, {
            width: lowSize.width * Number(scale),
            height: lowSize.height * Number(scale),
          });
      }
    }
    await page.selectOption("#render-scale", "8");
    await page.selectOption("#render-antialiasing", "1");
    await page.waitForFunction(() => tm4Port.antialiasing === 1);
    await capture("fxaa-menu");
    await page.selectOption("#render-antialiasing", "2");
    await page.waitForFunction(() => tm4Port.antialiasing === 2);
    await capture("smaa-menu-again");
    await page.selectOption("#render-antialiasing", "0");
    assert.equal(await page.locator("#render-preset").inputValue(), "custom");
    await page.waitForTimeout(100);
    const disabled = await page.evaluate(() => antialiasingProbe.draws);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => antialiasingProbe.draws), disabled);
    await page.selectOption("#render-preset", "ps1");
    assert.equal(await page.locator("#render-antialiasing").inputValue(), "0");
    await page.selectOption("#render-preset", "ultra");
    assert.equal(await page.locator("#render-antialiasing").inputValue(), "2");
    await page.locator("#render-settings > summary").click();
    await page.locator("canvas").click();
    await press("x");
    await screen("newgame");
    await press("x");
    await screen("carsel");
    await capture("car-selection");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(500);
    await capture("resized");
    await press("x");
    await page.waitForFunction(() => tm4Port.carTicks > 30, null, { timeout: 30000 });
    await capture("level");
    await page.locator("#render-settings > summary").click();
    await page.selectOption("#render-scale", "1");
    await page.waitForFunction(() => tm4Port.renderScale === 1);
    await page.locator("#render-settings > summary").click();
    await capture("level-scale-1");
    await page.screenshot({ path: resolve(output, "level-scale-1-presented.png") });
    await page.locator("canvas").click();
    await press("Enter");
    await page.waitForFunction(() => tm4Port.paused === true);
    await capture("pause");
    await press("x");
    await page.waitForFunction(() => tm4Port.paused === false);
    await capture("resumed");
    assert.equal(await page.evaluate(() => !!tm4Port.antialiasingFailed), false);
    assert.deepEqual(errors, []);
    console.log(
      `PASS: SMAA and FXAA toggles, presets, resize, gameplay and pause; paired captures in ${output}`,
    );
  } catch (error) {
    console.error("Browser errors:", errors);
    console.error("Startup:", await page.locator("#startup-progress").textContent());
    await page.screenshot({ path: resolve(output, "failure.png") });
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
