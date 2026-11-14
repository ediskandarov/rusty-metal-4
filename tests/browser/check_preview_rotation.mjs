/* global tm4Port, Module */
import assert from "node:assert/strict";

export default async function checkPreviewRotation(page) {
  assert.equal(await page.evaluate(() => tm4Port.screen), "carsel");
  const sample = () =>
    page.evaluate(() => ({
      frame: tm4Port.frames,
      angle: tm4Port.previewRotationAngle,
    }));
  const advance = async () => {
    const start = await sample();
    await page.waitForFunction((frame) => tm4Port.frames >= frame + 6, start.frame);
    const end = await sample();
    assert.notEqual(end.angle, start.angle, "Car preview must rotate without a test override");
  };
  await advance();
  await page.evaluate(() => Module._WebTestSetPreviewAngle(512));
  await page.waitForFunction(() => tm4Port.testPreviewAngle === 512);
  const fixed = await sample();
  await page.waitForFunction((frame) => tm4Port.frames >= frame + 6, fixed.frame);
  assert.equal((await sample()).angle, fixed.angle, "Fixed test view preserves the live angle");
  await page.evaluate(() => Module._WebTestSetPreviewAngle(-1));
  await page.waitForFunction(() => tm4Port.testPreviewAngle === -1);
  await advance();
  console.log("PASS automatic preview rotation, fixed test view and resumed rotation");
}
