/* global tm4Port, Module */
const { startDiagnosticGame, togglePanel } = require("./helpers/player.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 720 } });
    const errors = [];
    let rendererInitializations = 0;
    page.on("console", (message) => {
      if (/opengl .* initialized/.test(message.text())) ++rendererInitializations;
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      const blit = WebGL2RenderingContext.prototype.blitFramebuffer;
      WebGL2RenderingContext.prototype.blitFramebuffer = function (...args) {
        const result = blit.apply(this, args);
        const error = this.getError();
        if (error) (globalThis.renderGlErrors ||= []).push(error);
        return result;
      };
    });
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await startDiagnosticGame(page);
    assert.equal(await page.locator("#render-scale").inputValue(), "8");
    assert.equal(await page.locator("#render-preset").inputValue(), "ultra");
    assert.equal(await page.locator("#subpixel-vertices").isChecked(), true);
    assert.equal(await page.locator("#perspective-textures").isChecked(), true);
    const smoothing = page.locator("#render-smoothing");
    const slider = page.locator("#render-smoothing-delay");
    const readout = page.locator("#render-smoothing-readout");
    assert.equal(await smoothing.isChecked(), true);
    assert.equal(await slider.inputValue(), "7");
    const checkSettings = async (label) => {
      await togglePanel(page, "render-settings");
      for (const preset of ["ultra", "ps1"]) {
        await page.selectOption("#render-preset", preset);
        const enhanced = preset === "ultra";
        const scale = enhanced ? 8 : 1;
        const timing = enhanced ? 120 : 30;
        await page.waitForFunction(
          ({ scale, timing, enhanced }) =>
            tm4Port.renderScale === scale &&
            tm4Port.carLodDistance === scale &&
            tm4Port.drawDistance === scale &&
            tm4Port.renderDithering === 0 &&
            tm4Port.renderLimit === timing &&
            tm4Port.subpixelVertices === enhanced &&
            tm4Port.perspectiveTextures === enhanced,
          { scale, timing, enhanced },
        );
        for (const id of ["subpixel-vertices", "perspective-textures"])
          assert.equal(await page.locator(`#${id}`).isChecked(), enhanced);
        assert.equal(await smoothing.isChecked(), enhanced);
        assert.equal(await slider.isEnabled(), enhanced);
        assert.equal(await slider.inputValue(), "7");
        assert.match(await readout.textContent(), /33\.3 ms.*Full interpolation.*No prediction/);
        if (label === "game")
          await page.waitForFunction((on) => tm4Port.renderSmoothing === on, enhanced);
        console.log("PASS", label, "preset", preset);
      }
      await page.selectOption("#render-scale", "2");
      assert.equal(await page.locator("#render-preset").inputValue(), "custom");
      await page.selectOption("#render-preset", "custom");
      assert.equal(
        await page.locator("#render-scale").inputValue(),
        "2",
        "Custom keeps current values",
      );
      for (const [id, key, values] of [
        ["car-lod-distance", "carLodDistance", [2, 4, 8, 1]],
        ["draw-distance", "drawDistance", [2, 4, 8, 1]],
        ["render-dithering", "renderDithering", [1, 0]],
        ["render-limit", "renderLimit", [30, 60, 120, 0]],
      ]) {
        for (const value of values) {
          const before = await page.evaluate(() =>
            tm4Port.screen === "level" ? tm4Port.levelFrames : tm4Port.frames,
          );
          await page.selectOption(`#${id}`, String(value));
          await page.waitForFunction(
            ([key, value, before]) =>
              tm4Port[key] === value &&
              (tm4Port.screen === "level" ? tm4Port.levelFrames : tm4Port.frames) > before + 2,
            [key, value, before],
          );
          assert.equal(await page.locator("#render-preset").inputValue(), "custom");
          console.log("PASS", label, id, value);
        }
      }
      await page.selectOption("#render-scale", "0");
      await page.waitForFunction(() => tm4Port.renderScale === 3);
      await page.selectOption("#render-scale", "3");
      await page.selectOption("#render-dithering", "1");
      await page.selectOption("#render-limit", "60");
      await page.waitForFunction(
        () =>
          tm4Port.renderScale === 3 && tm4Port.renderDithering === 1 && tm4Port.renderLimit === 60,
      );
      await page.locator("#subpixel-vertices").check();
      await page.waitForFunction(() => tm4Port.subpixelVertices === true);
      const counter = page.locator(".performance-row output").nth(1);
      await page.locator("#render-fps").check();
      await page.waitForFunction(() =>
        /^[0-9.]+ FPS$/.test(document.querySelectorAll(".performance-row output")[1].textContent),
      );
      const fps = parseFloat(await counter.textContent());
      assert(fps > 0 && fps < 240, `unexpected FPS ${fps}`);
      console.log("PASS", label, "FPS", fps);
      await page.screenshot({ path: `build/checks/render-settings-${label}.png` });
      await page.selectOption("#car-lod-distance", "8");
      await page.waitForFunction(() => tm4Port.carLodDistance === 8);
      await page.selectOption("#draw-distance", "8");
      await page.waitForFunction(() => tm4Port.drawDistance === 8);
      await smoothing.check();
      for (let step = 6; step >= 0; step--) {
        await slider.press("ArrowLeft");
        assert.equal(await slider.inputValue(), String(step));
        assert.match(await readout.textContent(), new RegExp(`^${step * 5} ms · Up to `));
        assert.equal(await slider.getAttribute("aria-valuetext"), await readout.textContent());
        assert.equal(await page.locator("#render-preset").inputValue(), "custom");
        assert.equal(await page.locator("#render-limit").inputValue(), "60");
        if (label === "game") {
          const lead = 1 - (step * 5) / (1000 / 30);
          await page.waitForFunction(
            (lead) => tm4Port.renderSmoothing && tm4Port.renderSmoothingLead === lead,
            lead,
          );
        }
      }
      assert.match(await readout.textContent(), /0 ms · Up to 33\.3 ms prediction/);
      await slider.press("ArrowRight");
      assert.equal(await slider.inputValue(), "1");
      assert.match(await readout.textContent(), /5 ms · Up to 28\.3 ms prediction/);
      await smoothing.uncheck();
      assert.equal(await slider.isDisabled(), true);
      assert.equal(await slider.inputValue(), "1");
      if (label === "game") await page.waitForFunction(() => !tm4Port.renderSmoothing);
      await smoothing.check();
      assert.equal(await slider.inputValue(), "1", "toggle restores the selected delay");
      if (label === "game")
        await page.waitForFunction(
          () => tm4Port.renderSmoothing && tm4Port.renderSmoothingLead === 0.85,
        );
      await page.locator("#render-preset").selectOption("ultra");
      await slider.press("ArrowLeft");
      assert.equal(await slider.inputValue(), "6");
      assert.equal(await page.locator("#render-preset").inputValue(), "custom");
      await page.locator("#render-reset").click();
      assert.equal(await smoothing.isChecked(), true);
      assert.equal(await slider.inputValue(), "7");
      if (label === "game")
        await page.waitForFunction(
          () => tm4Port.renderSmoothing && tm4Port.renderSmoothingLead === 0,
        );
      assert.equal(await page.locator("#render-preset").inputValue(), "ultra");
      assert.equal(await counter.isVisible(), false);
      assert.equal(await page.locator("#render-fps").isChecked(), false);
      assert.equal(await page.locator("#subpixel-vertices").isChecked(), true);
      assert.equal(await page.locator("#perspective-textures").isChecked(), true);
      await page.waitForFunction(
        () => tm4Port.subpixelVertices === true && tm4Port.perspectiveTextures === true,
      );
      await page.waitForFunction(
        () =>
          tm4Port.drawDistance === 8 &&
          tm4Port.carLodDistance === 8 &&
          tm4Port.renderScale === 8 &&
          tm4Port.renderDithering === 0 &&
          tm4Port.renderLimit === 120,
      );
      for (const [id, value] of [
        ["render-scale", "8"],
        ["render-dithering", "0"],
        ["render-limit", "120"],
        ["car-lod-distance", "8"],
        ["draw-distance", "8"],
      ]) {
        assert.equal(await page.locator(`#${id}`).inputValue(), value);
      }
      await page.locator("#render-limit").focus();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#render-settings").evaluate((node) => node.open), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), "canvas");
      // PsyZ's desktop Escape shortcut must not destroy the browser renderer.
      const presented = await page.evaluate(() => Module._WebGetPresentedFrames());
      assert(rendererInitializations > 0);
      const initializations = rendererInitializations;
      await page.keyboard.down("Escape");
      await page.waitForTimeout(200);
      await page.keyboard.up("Escape");
      await page.waitForFunction(
        (before) => Module._WebGetPresentedFrames() > before + 3,
        presented,
        { timeout: 5000 },
      );
      assert.equal(
        rendererInitializations,
        initializations,
        "Escape must not recreate the renderer",
      );
      console.log("PASS", label, "Escape preserves the renderer and keeps presenting frames");
    };
    await checkSettings("menu");
    await togglePanel(page, "render-settings");
    await page.selectOption("#render-scale", "0");
    await togglePanel(page, "render-settings");
    for (const [width, height, scale] of [
      [640, 480, 2],
      [320, 480, 1],
      [1600, 900, 3],
      [1200, 720, 3],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction((scale) => tm4Port.renderScale === scale, scale);
      console.log("PASS auto scale follows viewport", { width, height, scale });
    }
    // Arrow keys in the graphics panel must not select another game-menu item.
    const selection = await page.evaluate(() => tm4Port.selected);
    assert.equal(typeof selection, "number");
    await togglePanel(page, "render-settings");
    await page.locator("#render-dithering").focus();
    await page.keyboard.press("ArrowDown");
    await slider.press("ArrowDown");
    assert.equal(await slider.inputValue(), "6");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => tm4Port.selected), selection);
    await page.keyboard.press("Escape");
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
    await checkSettings("game");
    await page.setViewportSize({ width: 320, height: 480 });
    await togglePanel(page, "render-settings");
    await page.waitForFunction(() => {
      const box = document.getElementById("render-panel").getBoundingClientRect();
      return box.x >= 0 && box.right <= innerWidth && box.bottom <= innerHeight - 12;
    });
    await slider.scrollIntoViewIfNeeded();
    const range = await slider.boundingBox();
    const panel = await page.locator("#render-panel").boundingBox();
    assert(range && panel && range.x >= panel.x && range.x + range.width <= panel.x + panel.width);
    await page.screenshot({ path: "build/checks/render-settings-narrow.png" });
    await page.mouse.click(4, 450);
    assert.equal(await page.locator("#render-settings").evaluate((node) => node.open), false);
    assert.deepEqual(await page.evaluate(() => globalThis.renderGlErrors || []), []);
    assert.deepEqual(errors, []);
    console.log("PASS defaults, keyboard, narrow layout, no JS/GL errors");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
