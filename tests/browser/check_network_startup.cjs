/* global Module, tm4Port */
/* Direct C adapter checks. Summary equality is not complete-world rollback proof. */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--enable-unsafe-swiftshader", "--mute-audio"],
  });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.requestAnimationFrame = () => 0;
    });
    await page.goto(new URL("?authority=1", site).href);
    await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
      timeout: 60000,
      polling: 100,
    });
    const result = await page.evaluate(() => {
      const trials = [];
      const run = (view) => {
        if (!Module._WebNetRequestMatch(8, 0, 12345, view))
          throw new Error("Direct initialization failed");
        const initial = structuredClone(tm4Port.netMatch);
        const duplicate = Module._WebNetQueueTick(0);
        for (let tick = 0; tick < 60; ++tick) {
          for (let slot = 0; slot < 8; ++slot) {
            if (!Module._WebNetSetInput(tick, slot, slot === 7 && tick < 30 ? 0x40 : 0, 0, 0))
              throw new Error("Input refused");
          }
          if (!Module._WebNetQueueTick(tick)) throw new Error("Step refused");
        }
        const state = structuredClone(tm4Port.netMatch);
        const cars = structuredClone(tm4Port.cars);
        const cheat = Module._WebSetCheat(1, 1);
        const stale = Module._WebNetQueueTick(59);
        Module._WebNetCancelMatch();
        return { initial, state, cars, duplicate, stale, cheat };
      };
      trials.push(run(-1));
      trials.push(run(7));
      Module.FS.rename("/DATA/GAME.MR", "/DATA/GAME.MR.missing");
      const failed = Module._WebNetRequestMatch(8, 0, 12345, -1);
      const failedState = tm4Port.netMatch;
      Module.FS.rename("/DATA/GAME.MR.missing", "/DATA/GAME.MR");
      trials.push(run(6));
      return {
        trials,
        failed,
        failedState,
        movie: tm4Port.movie,
        frames: Module._WebGetPresentedFrames(),
      };
    });
    assert.equal(result.movie, undefined);
    assert.equal(result.frames, 0, "Initialization and explicit stepping presented a frame");
    assert.equal(result.failed, 0);
    assert.equal(result.failedState, undefined);
    for (const trial of result.trials) {
      assert.equal(trial.initial.tick, 0);
      assert.equal(trial.state.tick, 60);
      assert.equal(trial.duplicate, 0);
      assert.equal(trial.stale, 0);
      assert.equal(trial.cheat, 0);
      assert.deepEqual(trial.initial, result.trials[0].initial);
      assert.deepEqual(trial.state, result.trials[0].state);
      assert.deepEqual(trial.cars, result.trials[0].cars);
    }
    const controls = await page.evaluate(() => {
      const results = [];
      for (let view = 0; view < 8; ++view) {
        if (!Module._WebNetRequestMatch(8, 0, 12345, view))
          throw new Error("Slot initialization failed");
        for (let tick = 0; tick < 8; ++tick) {
          for (let slot = 0; slot < 8; ++slot)
            Module._WebNetSetInput(tick, slot, slot === view ? 0x40 : 0, 0, 0);
          Module._WebNetQueueTick(tick);
        }
        results.push(tm4Port.cars.map((car) => ({ slot: car.player, throttle: car.throttle })));
        Module._WebNetCancelMatch();
      }
      return results;
    });
    for (const [slot, cars] of controls.entries())
      for (const car of cars)
        assert.equal(car.throttle !== 0, car.slot === slot, `control ownership for slot ${slot}`);
    console.log(
      "PASS: no-frame/no-menu startup, 60-step repeatability, slots 0–7, stop/start, missing-resource retry, cheat/input rejection",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
