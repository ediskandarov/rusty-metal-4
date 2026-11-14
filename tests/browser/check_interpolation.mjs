import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
/* global tm4Port, Module */
import { startDiagnosticGame, togglePanel } from "./helpers/player.mjs";

// Exercise 60 Hz even when headless Chrome defaults to a 30 Hz clock.
const browser = await launchBrowser({ args: ["--disable-frame-rate-limit"] });
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 540 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const press = async (key) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
    await page.waitForTimeout(150);
  };
  const menu = (name) =>
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  const state = () =>
    page.evaluate(() => ({
      ms: performance.now(),
      frames: tm4Port.levelFrames,
      ticks: tm4Port.simulationTicks,
      renderCounter: Module._WebGetRenderedFrames(),
      stepCounter: Module._WebGetSimulationSteps(),
    }));
  const measure = async (label, minimum, maximum) => {
    const start = await state();
    await page.waitForTimeout(2500);
    const end = await state();
    const seconds = (end.ms - start.ms) / 1000;
    const frames = (end.frames - start.frames) / seconds;
    const ticks = (end.ticks - start.ticks) / seconds;
    console.log(label, { frames, ticks });
    assert.equal(end.stepCounter - start.stepCounter, end.ticks - start.ticks);
    assert(Math.abs(end.renderCounter - start.renderCounter - (end.frames - start.frames)) <= 1);
    assert.equal(await page.locator(".performance-row").count(), 3);
    for (const line of await page.locator(".performance-row polyline").all())
      assert((await line.getAttribute("points")).length > 0);
    assert(frames >= minimum && frames <= maximum, label + " fresh frame rate");
    assert(ticks >= 28 && ticks <= 32, label + " simulation tick rate");
  };

  const url = new URL(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
  url.searchParams.set("fps", "1");
  await page.goto(url.href);
  await startDiagnosticGame(page);
  await togglePanel(page, "render-settings");
  await page.selectOption("#render-preset", "ps1");
  await togglePanel(page, "render-settings");
  await page.locator("canvas").click();
  await press("x");
  await menu("newgame");
  await press("x");
  await menu("carsel");
  await press("x");
  await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30, null, {
    timeout: 30000,
  });
  const smoothing = page.locator("#render-smoothing");
  assert.equal(await smoothing.isChecked(), false);
  assert.equal(await page.evaluate(() => tm4Port.renderSmoothing), false);
  await measure("OFF", 26, 34);

  await togglePanel(page, "render-settings");
  await smoothing.check();
  await page.selectOption("#render-limit", "60");
  await page.waitForFunction(() => tm4Port.renderSmoothing && tm4Port.renderSmoothingLead === 0);
  await measure("ON", 48, 66);

  await togglePanel(page, "render-settings");
  await page.locator("canvas").click();
  const origin = await page.evaluate(() => [tm4Port.carX, tm4Port.carZ]);
  await page.keyboard.down("x");
  await page.waitForFunction(() => tm4Port.carThrottle === 15);
  await page.waitForFunction(
    ([x, z]) => Math.hypot(tm4Port.carX - x, tm4Port.carZ - z) > 20,
    origin,
  );
  await page.keyboard.up("x");
  await page.waitForFunction(() => tm4Port.carThrottle === 0);

  await press("Enter");
  await page.waitForFunction(() => tm4Port.paused === true);
  const paused = await state();
  await page.waitForTimeout(600);
  assert.equal((await state()).ticks, paused.ticks, "pause freezes simulation");
  assert.equal((await state()).stepCounter, paused.stepCounter, "pause freezes TPS counter");
  assert.equal(await page.locator(".performance-row output").first().textContent(), "0.0 TPS");
  await press("x");
  await page.waitForFunction(
    (ticks) => !tm4Port.paused && tm4Port.simulationTicks > ticks,
    paused.ticks,
  );
  assert.equal(await page.evaluate(() => tm4Port.renderSmoothing), true);

  if (!(await page.locator("#render-settings").evaluate((node) => node.open)))
    await togglePanel(page, "render-settings");
  await page.locator("#render-reset").click();
  assert.equal(await page.locator("#render-preset").inputValue(), "ultra");
  assert.equal(await page.locator("#fps-counter").isVisible(), false);
  await page.locator("#render-fps").check();
  assert.equal(await smoothing.isChecked(), true);
  await page.waitForFunction(() => tm4Port.renderSmoothing && tm4Port.renderSmoothingLead === 0);
  // Measure baseline cadence independently of Ultra's heavier rendering workload.
  await page.selectOption("#render-preset", "ps1");
  await page.waitForFunction(() => !tm4Port.renderSmoothing);
  await measure("PS1", 26, 34);
  assert.deepEqual(errors, []);
  console.log("PASS interpolation cadence, driving, pause and Restore defaults");
} finally {
  await browser.close();
}
