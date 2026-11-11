/* global tm4Port */
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { chromium } = require("playwright");

const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
const endpoint = process.env.TM4_MATCH_ENDPOINT;
const token = process.env.TM4_AUTHORITY_TOKEN;
const prelude = Number(process.env.TM4_RESUME_TEST_TICKS ?? 360);
const exactWindow = process.env.TM4_RESUME_EXACT_WINDOW === "1";
assert(endpoint && token && Number.isInteger(prelude) && prelude >= 120);
const credentialKey = "tm4.resume." + endpoint;
const target = new URL(site);
target.searchParams.set("match", endpoint);

(async () => {
  const authority = Bun.spawn(
    [process.execPath, join(__dirname, "../../tools/network/authority.ts")],
    { stdout: "inherit", stderr: "inherit", env: { ...process.env, TM4_AUTHORITY_TIMING: "1" } },
  );
  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const errors = [];
    const open = async (resume, mode) => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.log("PAGE ERROR", mode ?? "normal", error.message);
      });
      page.on("console", (msg) => {
        if (
          msg.type() === "error" &&
          /Match clock at disconnect|Lightyear runtime failure/.test(msg.text())
        ) {
          console.log("DISCONNECT", mode ?? "normal", msg.text());
          void Promise.all(msg.args().map((arg) => arg.jsonValue())).then(
            (details) => console.log("DETAILS", JSON.stringify(details)),
            () => {},
          );
        }
      });
      if (resume) {
        await page.addInitScript(
          ([key, resume]) => sessionStorage.setItem(key, resume),
          [credentialKey, resume],
        );
      }
      await page.route("**/network/tm4_network.js", async (route) => {
        const response = await route.fetch();
        const hook = `
          const savedSend = NetworkClient.prototype.send;
          if (${JSON.stringify(mode)} === "incompatible") {
            NetworkClient.prototype.send = function(raw) {
              const request = JSON.parse(raw);
              if (request.type === "resume") request.compatibility.build = "0".repeat(64);
              return savedSend.call(this, JSON.stringify(request));
            };
          }
          const savedUpdate = NetworkClient.prototype.update;
          let conditioned = false;
          let observedBridge;
          let handoff;
          const local = new Map();
          NetworkClient.prototype.update = function() {
            const bridge = globalThis.tm4LivePrediction;
            if (bridge && bridge !== observedBridge) {
              observedBridge = bridge;
              local.clear();
              const step = bridge.step_live_tick;
              bridge.step_live_tick = (tick) => {
                const result = step(tick);
                if (result) {
                  const { digest, sections } = globalThis.tm4Port.netMatch;
                  local.set(tick + 1, [digest, ...sections]);
                  if (local.size > 120) local.delete(local.keys().next().value);
                }
                return result;
              };
            }
            if (${JSON.stringify(mode)} && !conditioned && this.connected()) {
              this.condition(72, 12);
              conditioned = true;
            }
            const messages = JSON.parse(savedUpdate.call(this));
            if (${JSON.stringify(exactWindow && mode === "delay")}) {
              const index = messages.findIndex(({type}) => type === "resume_live");
              if (index >= 0) [handoff] = messages.splice(index, 1);
              if (handoff) {
                const depth = (this.prediction_clock() - handoff.anchor - handoff.head) | 0;
                if (depth >= 12) {
                  globalThis.testReconnectDepth = depth;
                  messages.push(handoff);
                  handoff = undefined;
                }
              }
            }
            for (const message of messages) {
              if (message.type === "resume_live")
                globalThis.testReconnectDepth =
                  (this.prediction_clock() - message.anchor - message.head) | 0;
              if (message.type === "snapshot_begin") {
                const port = globalThis.tm4Port;
                const game = globalThis.Module;
                port.testMixerStarts = [];
                globalThis.testPresentationTicks = [];
                const confirm = game._WebNetConfirmPresentationTick;
                game._WebNetConfirmPresentationTick = (tick) => {
                  globalThis.testPresentationTicks.push(tick);
                  return confirm(tick);
                };
              }
              if (message.type === "snapshot_chunk") {
                document.documentElement.dataset.snapshot = String(message.offset + message.data.length);
                if (${JSON.stringify(mode)} === "corrupt" && message.offset === 0) message.data[0] ^= 1;
              }
              if (message.type === "frame") {
                const states = globalThis.testVerifiedStates ||= [];
                if (states.length === 120) states.shift();
                const digests = local.get(message.tick + 1);
                const authority = [message.state.digest, ...message.state.sections];
                if (!digests || digests.some((digest, i) => digest !== authority[i]))
                  throw new Error("Locally sampled simulation disagrees at tick " + (message.tick + 1));
                states.push([message.tick + 1, digests]);
              }
            }
            return JSON.stringify(messages);
          };
        `;
        const headers = response.headers();
        delete headers["content-length"];
        await route.fulfill({
          status: response.status(),
          headers,
          body: (await response.text()) + hook,
        });
      });
      await page.goto(target.href);
      return page;
    };
    const status = (page) => page.locator("#status").textContent();
    const confirmed = (page) => page.evaluate(() => tm4Port.netConfirmedTick ?? 0);
    const waitTick = async (page, tick) => {
      await page.waitForFunction(
        (tick) =>
          (globalThis.tm4Port?.netConfirmedTick ?? 0) >= tick ||
          document.querySelector("#status")?.dataset.matchState === "error",
        tick,
        { timeout: Math.max(20_000, prelude * 40), polling: 75 },
      );
      assert((await confirmed(page)) >= tick, await status(page));
    };
    const first = await open();
    await first.waitForFunction(
      () => {
        const status = document.querySelector("#status");
        return (
          status?.textContent.includes("Waiting for the other players") ||
          status?.dataset.matchState === "error"
        );
      },
      null,
      { timeout: 35_000 },
    );
    assert((await status(first)).includes("Waiting for the other players"), await status(first));
    const survivor = await open();
    await Promise.all([waitTick(first, 60), waitTick(survivor, 60)]);
    const credential = await first.evaluate((key) => sessionStorage.getItem(key), credentialKey);
    assert.match(credential, /^[a-f0-9]{64}$/);

    const duplicate = await open(credential);
    await duplicate.locator("#status").filter({ hasText: "cannot resume" }).waitFor();
    await duplicate.close();
    await first.locator("canvas").focus();
    await first.keyboard.down("x");
    await waitTick(first, 100);
    await first.keyboard.up("x");
    await waitTick(first, prelude);
    const dropTick = await confirmed(first);
    await first.close();
    await waitTick(survivor, dropTick + 30);

    const incompatible = await open(credential, "incompatible");
    await incompatible.locator("#status").filter({ hasText: "cannot resume" }).waitFor();
    await incompatible.close();

    const interrupted = await open(credential, "delay");
    await interrupted.locator("html[data-snapshot]").waitFor();
    await interrupted.close();
    await waitTick(survivor, dropTick + 70);

    const malformed = await open(credential, "corrupt");
    await malformed
      .locator("#status")
      .filter({ hasText: "Corrupt reconnect snapshot" })
      .waitFor({ timeout: 20_000 });
    await malformed.close();
    const beforeResume = await confirmed(survivor);
    await waitTick(survivor, beforeResume + 20);
    const recovered = await open(credential, "delay");
    await recovered.waitForFunction(
      () => {
        const status = document.querySelector("#status");
        return (
          status?.textContent.includes("Live prediction") || status?.dataset.matchState === "error"
        );
      },
      null,
      { timeout: 30_000 },
    );
    const result = await status(recovered);
    if (!result.includes("Live prediction"))
      console.log(
        "HANDOFF FAILURE",
        await recovered.evaluate(() => ({
          depth: globalThis.testReconnectDepth,
          diagnostics: tm4Port.netDiagnostics,
        })),
      );
    assert(result.includes("Live prediction"), result);
    const reconnected = await recovered.evaluate(() => ({
      slot: tm4Port.netViewSlot,
      render: tm4Port.renderLimit,
      diagnostics: tm4Port.netDiagnostics,
      confirmed: tm4Port.netConfirmedTick,
      handoffDepth: globalThis.testReconnectDepth,
    }));
    assert(reconnected.diagnostics.snapshotTick >= dropTick, JSON.stringify(reconnected));
    assert(reconnected.diagnostics.recoveredTick >= reconnected.diagnostics.snapshotTick);
    assert(reconnected.diagnostics.recoveredTick - reconnected.diagnostics.snapshotTick < 240);
    assert.equal(reconnected.render, 30);
    if (exactWindow) {
      assert.equal(reconnected.handoffDepth, 12);
      assert.equal(reconnected.diagnostics.transport.prediction.maxDepth, 12);
      assert(reconnected.diagnostics.transport.prediction.windowWaits > 0);
    }
    console.log("HANDOFF", JSON.stringify(reconnected));
    await recovered.locator("canvas").focus();
    await recovered.keyboard.down("x");
    await recovered.keyboard.down("w");
    await recovered.waitForFunction(
      () =>
        (tm4Port.netViewSlot === 0 && tm4Port.cars?.[0]?.throttle > 0) ||
        document.querySelector("#status")?.dataset.matchState === "error",
      null,
      { timeout: 5_000 },
    );
    assert((await status(recovered)).includes("Live prediction"), await status(recovered));
    await Promise.all([
      waitTick(survivor, reconnected.confirmed + 45),
      waitTick(recovered, reconnected.confirmed + 45),
    ]);
    await recovered.keyboard.up("w");
    await recovered.keyboard.up("x");
    const presentation = await recovered.evaluate(() => ({
      ticks: globalThis.testPresentationTicks,
      sounds: tm4Port.testMixerStarts,
    }));
    assert(presentation.ticks.length >= 20);
    assert(presentation.ticks.every((tick) => tick > reconnected.diagnostics.recoveredTick));
    assert(presentation.ticks.every((tick, i, ticks) => i === 0 || ticks[i - 1] + 1 === tick));
    assert(presentation.sounds.length > 0, "No mixer starts after reconnect");
    assert(!presentation.sounds.some((entry) => entry[5]), "Mixer started during replay");
    const [sourceFrames, recoveredFrames] = await Promise.all(
      [survivor, recovered].map((page) => page.evaluate(() => globalThis.testVerifiedStates)),
    );
    const source = new Map(sourceFrames);
    const common = recoveredFrames.filter(
      ([tick]) => tick > reconnected.confirmed && source.has(tick),
    );
    assert(common.length >= 20);
    for (const [tick, sections] of common) assert.deepEqual(sections, source.get(tick));
    assert.deepEqual(errors, []);
    console.log(
      "PASS live snapshot reconnect",
      JSON.stringify({
        dropTick,
        snapshotTick: reconnected.diagnostics.snapshotTick,
        snapshotBytes: reconnected.diagnostics.snapshotBytes,
        caughtUpTick: reconnected.diagnostics.recoveredTick,
        replayMs: reconnected.diagnostics.replayMs,
        sameTickCount: common.length,
        presentationTicks: presentation.ticks.length,
        mixerStarts: presentation.sounds.length,
        survivor: await confirmed(survivor),
      }),
    );
  } finally {
    authority.kill();
    await browser.close();
    await authority.exited;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
