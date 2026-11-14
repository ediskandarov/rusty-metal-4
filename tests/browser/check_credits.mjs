import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
/* global Module, tm4Port, creditCapture */
/* Check the original full-screen TIM path, including both gallery directions. */
import { startDiagnosticGame } from "./helpers/player.mjs";

const browser = await launchBrowser();
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
    if (
      /^CREDIT\d+$/.test(globalThis.tm4Port?.screen) &&
      tm4Port.menuReady &&
      this.getParameter(this.DRAW_FRAMEBUFFER_BINDING) === null
    ) {
      globalThis.creditCapture = { name: tm4Port.screen, png: this.canvas.toDataURL() };
    }
    return result;
  };
});
const press = async (key) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(150);
  await page.keyboard.up(key);
  await page.waitForTimeout(150);
};
const screen = (name) =>
  page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
    timeout: 30000,
  });
try {
  await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
  await startDiagnosticGame(page);
  await page.locator("canvas").click();
  await press("ArrowUp");
  await press("x");
  await screen("options");
  await press("ArrowUp");
  await press("x");
  await screen("CREDIT1");
  const count = await page.evaluate(
    () => Module.FS.readdir("/DATA/MENU").filter((name) => /^CREDIT\d+\.TIM$/.test(name)).length,
  );
  assert.equal(count, 22);
  for (let i = 1; i <= count; ++i) {
    const name = `CREDIT${i}`;
    await screen(name);
    await page.waitForFunction((name) => globalThis.creditCapture?.name === name, name);
    await page.waitForTimeout(150);
    const tim = Buffer.from(
      await page.evaluate((name) => Array.from(Module.FS.readFile(`/DATA/MENU/${name}.TIM`)), name),
    );
    assert.equal(tim.readUInt32LE(4), 2);
    const expected = Array.from({ length: 320 * 240 }, (_, p) => tim.readUInt16LE(20 + p * 2));
    const diff = await page.evaluate(async (expected) => {
      const image = new Image();
      image.src = creditCapture.png;
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
      // The footer contains live navigation hints over the original image.
      for (let y = 0; y < 210; ++y)
        for (let x = 0; x < 320; ++x) {
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
    }, expected);
    console.log(name, diff);
    assert(diff.mean < 2 && diff.changed < 0.02, `${name} differs from the original image`);
    assert.deepEqual(errors, []);
    if (i === 2) {
      await press("d");
      await screen("CREDIT1");
      await press("x");
      await screen("CREDIT2");
    }
    await press("x");
  }
  await screen("options");
  await press("ArrowUp");
  await press("x");
  await screen("CREDIT1");
  await press("s");
  await screen("options");
  assert.deepEqual(errors, []);
  console.log("PASS all 22 original credit images, backward navigation, end and cancel");
} catch (e) {
  await page.screenshot({ path: "build/checks/credits-failure.png" });
  console.error("STATE", await page.evaluate(() => tm4Port), "ERRORS", errors);
  throw e;
} finally {
  await browser.close();
}
