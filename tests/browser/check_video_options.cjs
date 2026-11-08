/* global tm4Port, presentedRect */
/* Normal menu -> card save -> reload -> gameplay, observed at final presentation. */
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
  await page.addInitScript(() => {
    const blit = WebGL2RenderingContext.prototype.blitFramebuffer;
    WebGL2RenderingContext.prototype.blitFramebuffer = function (...args) {
      const result = blit.apply(this, args);
      if (this.getParameter(this.DRAW_FRAMEBUFFER_BINDING) === null) {
        globalThis.presentedRect = {
          x: args[4],
          y: this.drawingBufferHeight - args[7],
          w: args[6] - args[4],
          h: args[7] - args[5],
        };
      }
      return result;
    };
  });
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
  const rect = () => page.evaluate(() => presentedRect);
  try {
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await require("./browser_startup.cjs")(page);
    await page.locator("canvas").click();
    const original = await rect();
    await press("ArrowUp");
    await press("x");
    await screen("options");
    await press("ArrowDown");
    await press("x");
    await screen("video");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("x");
    await screen("adjusts");
    await press("ArrowRight");
    await press("ArrowDown");
    const adjusted = await rect();
    assert(adjusted.x > original.x && adjusted.y > original.y);
    assert.equal(adjusted.w, original.w);
    assert.equal(adjusted.h, original.h);
    await page.screenshot({ path: "build/checks/video-adjusted.png" });
    await press("s");
    await screen("video");
    await press("s");
    await screen("options");
    await press("s");
    await page.waitForFunction(() => /SAVE SETTINGS/.test(tm4Port.dialog));
    await press("x");
    await page.waitForFunction(
      () =>
        tm4Port.screen === "main" && !tm4Port.dialog && localStorage.getItem("tm4.memory-card.0"),
      null,
      { timeout: 20000 },
    );
    assert.deepEqual(await rect(), adjusted);
    await page.reload();
    await require("./browser_startup.cjs")(page);
    await page.waitForFunction(() => tm4Port.frames > 30);
    assert.deepEqual(await rect(), adjusted, "saved screen adjustment survives a page reload");
    await page.locator("canvas").click();
    await press("x");
    await screen("newgame");
    await press("x");
    await screen("carsel");
    await press("x");
    await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30, null, {
      timeout: 30000,
    });
    assert.deepEqual(await rect(), adjusted, "gameplay uses the saved display adjustment");
    await page.screenshot({ path: "build/checks/video-adjusted-game.png" });
    assert.deepEqual(errors, []);
    console.log("PASS original screen controls, memory-card persistence and gameplay", {
      original,
      adjusted,
    });
  } catch (e) {
    console.error("STATE", await page.evaluate(() => tm4Port), "ERRORS", errors);
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
