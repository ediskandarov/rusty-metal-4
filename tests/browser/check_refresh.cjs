/* global tm4Port, Module */
/* Real elapsed-time injection; the menu setting and adaptive rendering remain original. */
const { startDiagnosticGame } = require("./helpers/player.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await launchBrowser();
  const settings = [];
  try {
    for (const toggle of [false, true]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => {
        if (/^WARNING: \[W\].*\[SquareRoot0_impl\] SquareRoot0\(-\d+\)/.test(m.text())) return;
        if (m.type() === "error" && !/^\[[ID]\]/.test(m.text())) errors.push(m.text());
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
      const state = () =>
        page.evaluate(() => ({
          timing: tm4Port.renderTiming,
          phases: tm4Port.renderPhaseCounts,
          ticks: tm4Port.simulationTicks,
          frames: tm4Port.levelFrames,
        }));
      try {
        await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
        await startDiagnosticGame(page);
        await page.locator("canvas").click();
        if (toggle) {
          await press("ArrowUp");
          await press("x");
          await screen("options");
          await press("ArrowDown");
          await press("x");
          await screen("video");
          await press("ArrowRight");
          await press("s");
          await screen("options");
          await press("s");
          await page.waitForFunction(() => /SAVE SETTINGS/.test(tm4Port.dialog));
          await press("x");
          await screen("main");
          await press("ArrowDown");
          assert.equal(await page.evaluate(() => tm4Port.selected), 0);
        }
        await press("x");
        await screen("newgame");
        await press("x");
        await screen("carsel");
        await press("x");
        await page.waitForFunction(
          () => tm4Port.screen === "level" && tm4Port.levelFrames > 30,
          null,
          { timeout: 30000 },
        );
        const initial = await state();
        settings.push(initial.timing.refreshPriority);
        await page.evaluate(() => Module._WebTestRenderDelay(80));
        await page.waitForFunction((t) => tm4Port.levelFrames > t + 25, initial.frames, {
          timeout: 20000,
        });
        const delayed = await state();
        assert(delayed.ticks > initial.ticks);
        assert(delayed.timing.late && delayed.timing.vblanks > 2);
        assert(delayed.timing.faceBudget >= delayed.timing.minimum);
        assert(delayed.timing.faceBudget <= delayed.timing.maximum);
        assert(
          delayed.timing.faceBudget < initial.timing.faceBudget ||
            delayed.timing.faceBudget === delayed.timing.minimum,
        );
        if (delayed.timing.refreshPriority) {
          assert(delayed.phases[1] > initial.phases[1]);
          assert(delayed.phases[2] > initial.phases[2]);
        } else {
          assert.equal(delayed.phases[1], 0);
          assert.equal(delayed.phases[2], 0);
        }
        console.log("PASS delayed rendering", { initial, delayed });
        await page.evaluate(() => Module._WebTestRenderDelay(0));
        await page.waitForFunction((t) => tm4Port.levelFrames > t + 15, delayed.frames);
        const resumed = await state();
        await press("Enter");
        await page.waitForFunction(() => tm4Port.paused === true);
        const paused = await state();
        await page.waitForTimeout(800);
        const held = await state();
        assert.equal(held.ticks, paused.ticks);
        assert.equal(held.timing.vblanks, 2);
        assert.equal(held.timing.late, false);
        await press("x");
        await page.waitForFunction(
          (t) => !tm4Port.paused && tm4Port.simulationTicks > t,
          held.ticks,
        );
        const afterPause = await state();
        assert(afterPause.timing.vblanks < 20, "paused time must not become rendering lateness");
        assert(resumed.frames > delayed.frames);
        assert.deepEqual(errors, []);
        console.log("PASS delay removed, pause timing and resumed simulation", afterPause);
      } catch (e) {
        console.error("STATE", await page.evaluate(() => tm4Port), "ERRORS", errors);
        throw e;
      } finally {
        await context.close();
      }
    }
    assert.notEqual(settings[0], settings[1], "the original menu must change Refresh Priority");
    console.log("PASS both Refresh Priority settings");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
