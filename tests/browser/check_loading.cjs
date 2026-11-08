/* global Module, loadingCaptures, tm4Port */
/* Observe the real display while the normal loading routines yield to the browser. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      window.loadingCaptures = {};
      // Capture before WebGL discards the default drawing buffer at frame end.
      const blit = WebGL2RenderingContext.prototype.blitFramebuffer;
      WebGL2RenderingContext.prototype.blitFramebuffer = function (...args) {
        const result = blit.apply(this, args);
        const state = window.tm4Port;
        if (
          state?.screen === "loading" &&
          state.loadingBackground &&
          this.getParameter(this.DRAW_FRAMEBUFFER_BINDING) === null
        ) {
          loadingCaptures[state.loadingBackground.toUpperCase()] = this.canvas.toDataURL();
        }
        return result;
      };
    });
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await require("./browser_startup.cjs")(page);
    async function press(key) {
      await page.keyboard.down(key);
      await page.waitForTimeout(120);
      await page.keyboard.up(key);
      await page.waitForTimeout(120);
    }
    async function screen(name) {
      await page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name);
    }
    await press("x");
    await screen("newgame");
    await press("x");
    await screen("carsel");
    await press("x");
    await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 10);
    for (const name of ["LEGAL.TIM", "YARD.TIM"]) {
      const png = await page.evaluate((name) => loadingCaptures[name], name);
      assert(png, `loading display was presented for ${name}`);
      fs.writeFileSync(
        `build/checks/loading-${name}.png`,
        Buffer.from(png.split(",")[1], "base64"),
      );
      const tim = Buffer.from(
        await page.evaluate((name) => Array.from(Module.FS.readFile(`/DATA/${name}`)), name),
      );
      assert.equal(tim.readUInt32LE(4), 2, "reference must be a direct-color TIM");
      assert.equal(tim.readUInt16LE(16), 320);
      assert.equal(tim.readUInt16LE(18), 240);
      const expected = Array.from({ length: 320 * 240 }, (_, i) => tim.readUInt16LE(20 + i * 2));
      const difference = await page.evaluate(
        async ({ png, expected }) => {
          const image = new Image();
          image.src = png;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = 320;
          canvas.height = 240;
          const context = canvas.getContext("2d");
          context.imageSmoothingEnabled = false;
          context.drawImage(image, 0, 0, 320, 240);
          const pixels = context.getImageData(0, 0, 320, 240).data;
          let total = 0,
            changed = 0,
            count = 0;
          for (let y = 0; y < 240; ++y)
            for (let x = 0; x < 320; ++x) {
              // The recovered progress bar intentionally changes this part of the image.
              if (y >= 185 && y <= 203 && x >= 40 && x <= 280) continue;
              const word = expected[y * 320 + x];
              for (let c = 0; c < 3; ++c) {
                const delta = Math.abs(
                  pixels[(y * 320 + x) * 4 + c] - Math.round((((word >> (c * 5)) & 31) * 255) / 31),
                );
                total += delta;
                changed += delta > 8;
                ++count;
              }
            }
          return { mean: total / count, changed: changed / count };
        },
        { png, expected },
      );
      assert(
        difference.mean < 2 && difference.changed < 0.02,
        `${name} display differs from original TIM: ${JSON.stringify(difference)}`,
      );
      console.log(name, difference);
    }
    assert.deepEqual(errors, []);
    console.log("PASS original loading images presented before menu and gameplay");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
