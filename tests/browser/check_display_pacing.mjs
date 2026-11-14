import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
/* global tm4Port, Module */
import { startDiagnosticGame, togglePanel } from "./helpers/player.mjs";

const browser = await launchBrowser({ headless: process.env.TM4_HEADED !== "1" });
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 540 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8195/?fps=1");
  await startDiagnosticGame(page);
  assert.equal(await page.locator("#render-limit").inputValue(), "120");
  assert.equal(await page.locator("#render-preset").inputValue(), "ultra");
  await page.locator("canvas").click();
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
  await press("x");
  await menu("newgame");
  await press("x");
  await menu("carsel");
  await press("x");
  await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30, null, {
    timeout: 30000,
  });
  await page.evaluate(() => {
    globalThis.pacingCallbacks = 0;
    const frame = () => {
      globalThis.pacingCallbacks++;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const state = () =>
    page.evaluate(() => ({
      time: performance.now(),
      frames: Module._WebGetRenderedFrames(),
      steps: Module._WebGetSimulationSteps(),
      callbacks: globalThis.pacingCallbacks,
    }));
  const select = async (id, value) => {
    await togglePanel(page, "render-settings");
    await page.selectOption(`#${id}`, String(value));
    await togglePanel(page, "render-settings");
    await page.locator("canvas").click();
    await page.waitForTimeout(1000);
  };
  const measure = async (label, limit) => {
    const start = await state();
    await page.waitForTimeout(8000);
    const end = await state();
    const seconds = (end.time - start.time) / 1000;
    const result = {
      label,
      renderFPS: (end.frames - start.frames) / seconds,
      simulationTPS: (end.steps - start.steps) / seconds,
      browserCallbacks: (end.callbacks - start.callbacks) / seconds,
    };
    console.log(JSON.stringify(result));
    assert(result.simulationTPS > 28 && result.simulationTPS < 32, "simulation remains 30 Hz");
    const expected = Math.min(limit || Infinity, result.browserCallbacks);
    assert(result.renderFPS <= expected + 1, "render respects the selected cap and RAF");
    assert(result.renderFPS > expected * 0.95, `${label}: no lost render cadence`);
    return result;
  };
  await measure("Ultra", 120);
  await select("render-preset", "ps1");
  assert.equal(await page.locator("#render-limit").inputValue(), "30");
  await measure("PS1", 30);
  await select("render-preset", "ultra");
  for (const rate of [30, 60, 120, 0]) {
    await select("render-limit", rate);
    assert.equal(await page.locator("#render-preset").inputValue(), "custom");
    await measure(`Custom ${rate || "display"}`, rate);
  }
  await select("render-limit", 120);
  let repeating = true;
  const repeats = (async () => {
    while (repeating) {
      await page.keyboard.down("j");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  })();
  try {
    await measure("unmapped key repeat", 120);
  } finally {
    repeating = false;
    await repeats;
    await page.keyboard.up("j");
  }
  await press("Enter");
  await page.waitForFunction(() => tm4Port.paused);
  const paused = await state();
  await page.waitForTimeout(1000);
  assert.equal((await state()).steps, paused.steps, "pause stops simulation");
  await press("x");
  await page.waitForFunction(() => !tm4Port.paused);
  await measure("resumed", 120);
  assert.deepEqual(errors, []);
  console.log("PASS render limits, presets, key repeat and pause/resume");
} finally {
  await browser.close();
}
