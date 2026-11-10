/* global tm4Port, Module */
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { chromium, webkit } = require("playwright");

const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
const endpoint = process.env.TM4_MATCH_ENDPOINT;
const token = process.env.TM4_AUTHORITY_TOKEN;
const useWebKit = process.env.TM4_MANUAL_BROWSER === "webkit";
const forceWait = process.env.TM4_MANUAL_WINDOW_WAIT === "1";
assert(endpoint && token, "A fresh prediction-enabled match server is required");

(async () => {
  const authority = Bun.spawn(
    [process.execPath, join(__dirname, "../../tools/network/authority.ts")],
    { stdout: "inherit", stderr: "pipe", env: { ...process.env, TM4_AUTHORITY_TIMING: "1" } },
  );
  const authorityLog = new Response(authority.stderr).text();
  let results;
  const browser = useWebKit
    ? await webkit.launch()
    : await chromium.launch({
        executablePath: process.env.TM4_CHROME,
        channel: process.env.TM4_CHROME ? undefined : "chrome",
        args: ["--enable-unsafe-swiftshader"],
      });
  try {
    const errors = [];
    const target = new URL(site);
    target.searchParams.set("match", endpoint);
    const players = await Promise.all(
      Array.from({ length: 2 }, () => browser.newPage({ viewport: { width: 1280, height: 800 } })),
    );
    for (const page of players) page.on("pageerror", (error) => errors.push(error.message));
    await players[0].goto(target.href);
    await players[0]
      .locator("#status")
      .filter({ hasText: "Waiting for the other players" })
      .waitFor({
        timeout: 60_000,
      });
    await players[1].goto(target.href);
    if (forceWait) {
      await players[1].waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
        polling: 100,
        timeout: 45_000,
      });
      await players[1].evaluate(async () => {
        const { NetworkClient } = await import("/network/tm4_network.js");
        const update = NetworkClient.prototype.update;
        let configured = false;
        NetworkClient.prototype.update = function () {
          if (!configured && this.connected()) {
            this.condition(170, 65);
            configured = true;
          }
          const messages = update.call(this);
          if (!tm4Port.testInputWait && configured) {
            const { prediction } = JSON.parse(this.diagnostics());
            if (prediction.waitingForInput) {
              tm4Port.testInputWait = prediction;
              this.condition(0, 0);
            }
          }
          return messages;
        };
      });
    }
    const sample = (page) =>
      page.evaluate(() => ({
        status: document.querySelector("#status").textContent,
        confirmed: tm4Port.netConfirmedTick ?? 0,
        frames: tm4Port.levelFrames ?? 0,
        renderLimit: tm4Port.renderLimit,
        timingLocked:
          document.querySelector("#render-limit").disabled &&
          document.querySelector("#render-limit").value === "30" &&
          document.querySelector("#render-smoothing").disabled &&
          !document.querySelector("#render-smoothing").checked &&
          document.querySelector("#render-smoothing-delay").disabled,
        now: performance.now(),
        visible: document.visibilityState,
        wait: tm4Port.testInputWait,
      }));
    const waitConfirmed = async (page, tick) => {
      await page.waitForFunction(
        (tick) => {
          const state = document.querySelector("#status")?.dataset.matchState;
          return (globalThis.tm4Port?.netConfirmedTick ?? 0) >= tick || state === "error";
        },
        tick,
        { timeout: 45_000, polling: 100 },
      );
      const state = await sample(page);
      assert(
        state.confirmed >= tick && state.status.includes("Live prediction"),
        JSON.stringify(state),
      );
      return state;
    };
    const initial = await Promise.all(players.map((page) => waitConfirmed(page, 30)));
    for (const page of players) {
      await page.bringToFront();
      await page.locator("canvas").focus();
      await page.keyboard.down("x");
      const tick = (await sample(page)).confirmed;
      await page.waitForFunction(() => tm4Port.cars?.[tm4Port.netViewSlot]?.throttle > 0, null, {
        timeout: 4_000,
        polling: 50,
      });
      await waitConfirmed(page, tick + 25);
      await page.keyboard.up("x");
    }
    const final = await Promise.all(players.map((page) => waitConfirmed(page, 300)));
    assert(
      final.every(({ frames, renderLimit, timingLocked, now }, i) => {
        const fps = (1000 * (frames - initial[i].frames)) / (now - initial[i].now);
        return frames > initial[i].frames && renderLimit === 30 && timingLocked && fps <= 32;
      }),
      JSON.stringify(final),
    );
    await players[0].locator("#render-settings > summary").click();
    for (const preset of ["ps1", "ultra"]) {
      await players[0].selectOption("#render-preset", preset);
      assert((await sample(players[0])).timingLocked);
    }
    assert.deepEqual(errors, []);
    if (forceWait) {
      assert.equal(final[1].wait?.acceptedDepth, 12, JSON.stringify(final));
      assert.equal(final[1].wait?.windowWaits, 1);
    }
    if (process.env.TM4_MANUAL_SCREENSHOT)
      await players[0].screenshot({ path: process.env.TM4_MANUAL_SCREENSHOT });
    const restored = await players[0].evaluate(async () => {
      Module._WebNetCancelMatch();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        limit: document.querySelector("#render-limit").value,
        limitEnabled: !document.querySelector("#render-limit").disabled,
        smoothing: document.querySelector("#render-smoothing").checked,
        smoothingEnabled: !document.querySelector("#render-smoothing").disabled,
      };
    });
    assert.deepEqual(restored, {
      limit: "120",
      limitEnabled: true,
      smoothing: true,
      smoothingEnabled: true,
    });
    results = { initial, final, restored };
  } finally {
    authority.kill();
    await browser.close();
    await authority.exited;
    const log = await authorityLog;
    process.stderr.write(log);
    if (results) {
      const ticks = [...log.matchAll(/Authority tick (\d+), step (\d+\.\d+) ms, frames (\d+)/g)];
      assert(ticks.length >= 3 && ticks.every(([, , , frames]) => frames === "0"), log);
      console.log("PASS actual manual authority and default rendering", JSON.stringify(results));
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
