/* global Module, tm4Port */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const { connectAuthority } = await import("../../tools/network/authority.ts");
  const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
  const endpoint = process.env.TM4_MATCH_ENDPOINT;
  const token = process.env.TM4_AUTHORITY_TOKEN;
  if (!endpoint || !token) throw new Error("Set TM4_MATCH_ENDPOINT and TM4_AUTHORITY_TOKEN");
  const browser = await chromium.launch({
    channel: "chrome",
    args: [
      "--enable-unsafe-swiftshader",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  let authorityError;
  const errors = [];
  try {
    const authority = await browser.newPage();
    await authority.addInitScript(() => {
      window.requestAnimationFrame = () => 0;
    });
    await authority.goto(new URL("?authority=1", site).href);
    await authority.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
      polling: 100,
      timeout: 60000,
    });
    void connectAuthority(authority, endpoint, token).catch((error) => {
      authorityError = error;
    });
    const clients = [];
    for (let index = 0; index < 2; index++) {
      const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(new URL("?match=" + encodeURIComponent(endpoint), site).href);
      if (!index)
        await page.waitForFunction(
          () =>
            document.querySelector("#status").textContent.includes("Waiting for the other players"),
          null,
          { timeout: 60000 },
        );
      clients.push(page);
    }
    await Promise.all(
      clients.map((page) =>
        page.waitForFunction(() => globalThis.tm4Port?.netMatch?.tick > 30, null, {
          timeout: 60000,
        }),
      ),
    );
    const target = clients[0];
    await target.evaluate(() => {
      const sample = tm4Port.netMatchInput;
      const setInput = Module._WebNetSetInput;
      const test = (globalThis.analogSampling = {
        samples: 0,
        taps: 0,
        presses: 0,
        releases: 0,
        previous: 0,
        maxPending: 0,
        maxRustPending: 0,
        axes: new Set(),
        started: performance.now(),
        timer: 0,
      });
      Module._WebNetSetInput = (tick, slot, buttons, axes, analog) => {
        if (slot === 0) {
          if (buttons & 0x40 && !(test.previous & 0x40)) test.presses++;
          if (!(buttons & 0x40) && test.previous & 0x40) test.releases++;
          test.previous = buttons;
          if (analog) test.axes.add(axes);
        }
        return setInput(tick, slot, buttons, axes, analog);
      };
      // Exercise the production callback at high-refresh sampling frequency,
      // independent of the CI machine's physical display refresh rate.
      test.timer = setInterval(() => {
        const axes = (test.samples++ % 127) + 1;
        sample(0, axes, true);
        if (test.samples % 120 === 0) {
          sample(0x40, axes, true);
          sample(0, axes, true);
          test.taps++;
        }
        test.maxPending = Math.max(test.maxPending, tm4Port.netDiagnostics.pendingInputs);
        test.maxRustPending = Math.max(
          test.maxRustPending,
          tm4Port.netDiagnostics.transport.pendingInputs,
        );
      }, 1000 / 120);
    });
    await target.waitForTimeout(30000);
    await target.evaluate(() => {
      clearInterval(globalThis.analogSampling.timer);
      tm4Port.netMatchInput(0, 0, false);
    });
    await target.waitForTimeout(1000);
    const result = await target.evaluate(() => {
      const test = globalThis.analogSampling;
      return {
        samples: test.samples,
        samplesPerSecond: test.samples / ((performance.now() - test.started - 1000) / 1000),
        taps: test.taps,
        presses: test.presses,
        releases: test.releases,
        maxPending: test.maxPending,
        maxRustPending: test.maxRustPending,
        acceptedAxes: test.axes.size,
        tick: tm4Port.netMatch?.tick,
        diagnostics: tm4Port.netDiagnostics,
        status: document.querySelector("#status").textContent,
      };
    });
    console.log(JSON.stringify(result));
    assert.ok(
      result.samplesPerSecond > 100,
      "Producer did not exercise high-refresh analog sampling",
    );
    assert.ok(result.tick > 800, result.status);
    assert.ok(result.acceptedAxes > 20, "Changing analog values did not reach the C simulator");
    assert.equal(result.presses, result.taps);
    assert.equal(result.releases, result.taps);
    assert.ok(result.maxPending < 32, "Unacknowledged analog sample history accumulated");
    assert.ok(result.maxRustPending <= 4, "Native input queue accumulated analog samples");
    assert.ok(result.diagnostics.processedSequence > 2000);
    assert.equal(authorityError, undefined);
    assert.deepEqual(errors, []);
    for (const client of clients)
      assert.ok(await client.evaluate(() => tm4Port.netMatch?.tick > 800));
    console.log(
      "PASS: sustained high-rate analog sampling stays bounded and preserves batched taps through JS, Rust and C",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
