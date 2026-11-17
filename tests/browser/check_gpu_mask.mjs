import assert from "node:assert/strict";

/* global tm4GpuMaskResult */
import { launchBrowser } from "./helpers/browser.mjs";

const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => console.log(message.text()));
  await page.goto((process.env.TM4_WEB_URL || "http://127.0.0.1:8080/") + "gpu-mask-check/");
  await page.waitForFunction(() => window.tm4GpuMaskResult, null, { timeout: 30000 });
  assert.deepEqual(errors, []);
  const result = await page.evaluate(() => tm4GpuMaskResult);
  const extended = process.env.TM4_EXTENDED_VRAM === "1";
  assert.equal(result.failures, 0);
  assert.equal(result.atlasCount, extended ? 10 : 8);
  assert.equal(result.vramHeight, extended ? 1024 : 512);
  console.log(
    "PASS real WebGL GPU mask/dither packets, texture banks, car atlases and VRAM readback",
  );
} finally {
  await browser.close();
}
