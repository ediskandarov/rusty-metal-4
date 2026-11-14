/* global Module, tm4Port */
const assert = require("node:assert/strict");
const { launchBrowser } = require("./helpers/browser.cjs");

(async () => {
  const browser = await launchBrowser({ args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
    await page.goto(new URL("?session=1", site).href);
    await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
      timeout: 60_000,
      polling: 100,
    });
    const metrics = await page.evaluate(() => {
      const check = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      check(
        Module.ccall(
          "WebNetStartMatch",
          "number",
          ["number", "number", "number", "number", "number", "number", "string", "string"],
          [2, 3, 0, 12345, 0, 2, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
        ),
        "Could not start match",
      );
      tm4Port.testMixerStarts = [];
      const step = (tick, mask = 0) => {
        if (mask) Module._WebTestScheduleRollbackAudio(mask);
        for (let slot = 0; slot < 2; ++slot)
          check(Module._WebNetSetInput(tick, slot, 0, 0, 0), "Could not stage neutral input");
        check(Module._WebNetQueueTick(tick), "Could not step tick " + tick);
        return mask ? [...tm4Port.testAudioSerials] : [];
      };
      const starts = (serial) => tm4Port.testMixerStarts.filter(([id]) => serial === id);
      const active = () => Module._WebTestNetworkPlaybackVoices();
      step(0);
      check(Module._WebNetRetainLocalCheckpoint(1), "Could not retain audio fixture checkpoint");

      // Finite A plays on the original timeline. Stop its hardware voice so rebind
      // cannot conceal a duplicate. The loop remains bound through every correction.
      const [heard, loop] = step(1, 5).filter((id) => id >= 0);
      check(starts(heard).length === 1 && starts(heard)[0][3] >= 2, "Missing finite A");
      check(starts(loop).length === 1 && starts(loop)[0][3] < 0, "Missing ongoing loop");
      check(Module._WebTestStopRollbackAudio(heard) === 1, "Could not stop finite A");

      const replay = (mask) => {
        check(Module._WebNetRestoreLocalTick(1), "Could not restore audio fixture");
        const startsBefore = tm4Port.testMixerStarts.length;
        const serials = step(1, mask);
        check(Module._WebNetFinishLocalReplay(), "Could not finish audio replay");
        check(tm4Port.testMixerStarts.length === startsBefore, "Mixer started inside replay");
        return serials;
      };

      // Keep the original A and loop identities. Add the unheard B at the next tick.
      const [sameA, , sameLoop] = replay(5);
      check(sameA === heard && sameLoop === loop, "Original emitter identities moved");
      check(Module._WebNetRestoreLocalTick(1), "Could not restart corrected replay");
      const startsBefore = tm4Port.testMixerStarts.length;
      step(1, 5);
      const [, corrected] = step(2, 2);
      check(Module._WebNetFinishLocalReplay(), "Could not finish corrected audio replay");
      check(
        tm4Port.testMixerStarts.length === startsBefore,
        "Corrected sound started during replay",
      );
      step(3);
      check(starts(heard).length === 1, "Previously heard finite A restarted");
      check(
        starts(corrected).length === 1 && starts(corrected)[0][3] >= 2,
        "Unheard finite B did not play",
      );
      check(starts(loop).length === 1 && active() > 0, "Ongoing loop restarted or stopped");

      // Rebuild the same corrected timeline with both an active and a stopped B.
      for (const stop of [false, true]) {
        if (stop)
          check(Module._WebTestStopRollbackAudio(corrected) === 1, "Could not stop finite B");
        check(Module._WebNetRestoreLocalTick(1), "Could not restore repeated correction");
        step(1, 5);
        const [, repeated] = step(2, 2);
        check(repeated === corrected, "Corrected emitter identity changed");
        check(Module._WebNetFinishLocalReplay(), "Could not finish repeated audio replay");
        step(3);
        check(
          starts(heard).length === 1 && starts(corrected).length === 1,
          "Repeated reconciliation restarted a finite sound",
        );
        check(starts(loop).length === 1, "Repeated reconciliation restarted the loop");
      }

      const result = {
        heard: starts(heard),
        corrected: starts(corrected),
        loop: starts(loop),
        suppressed: tm4Port.rollbackVoicesSuppressed,
        reused: tm4Port.rollbackVoicesReused,
      };
      check(
        result.suppressed >= 2 && result.reused >= 2,
        "Ledger and rebind paths were not exercised",
      );
      Module._WebNetCancelMatch();
      return result;
    });
    assert.deepEqual(errors, []);
    console.log("PASS finite and looping rollback audio", JSON.stringify(metrics));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
