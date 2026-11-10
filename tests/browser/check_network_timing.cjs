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
    const [authority, ...clients] = await Promise.all(
      Array.from({ length: 3 }, () => browser.newPage({ viewport: { width: 720, height: 540 } })),
    );
    await authority.addInitScript(() => {
      window.requestAnimationFrame = () => 0;
    });
    await authority.goto(new URL("?authority=1", site).href);
    await authority.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
      timeout: 60000,
      polling: 100,
    });
    void connectAuthority(authority, endpoint, token).catch((error) => {
      authorityError = error;
    });
    await Promise.all(
      clients.map(async (page) => {
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(new URL("?match=" + encodeURIComponent(endpoint), site).href);
        await page.waitForFunction(() => globalThis.tm4Port?.netMatch?.tick > 15, null, {
          timeout: 60000,
        });
        await page.evaluate(() => {
          globalThis.networkTimingCallbacks = 0;
          const count = () => {
            globalThis.networkTimingCallbacks++;
            requestAnimationFrame(count);
          };
          requestAnimationFrame(count);
        });
      }),
    );
    const state = (page) =>
      page.evaluate(() => ({
        time: performance.now(),
        ticks: tm4Port.netMatch?.tick,
        steps: Module._WebGetSimulationSteps(),
        draws: Module._WebGetRenderedFrames(),
        callbacks: globalThis.networkTimingCallbacks,
        status: document.querySelector("#status").textContent,
      }));
    for (const limits of [
      [30, 0],
      [0, 30],
    ]) {
      for (const [index, page] of clients.entries())
        await page.evaluate((limit) => Module._WebSetRenderLimit(limit), limits[index]);
      await clients[0].waitForTimeout(500);
      const before = await Promise.all(clients.map(state));
      await clients[0].waitForTimeout(3000);
      const after = await Promise.all(clients.map(state));
      for (let index = 0; index < clients.length; index++) {
        const seconds = (after[index].time - before[index].time) / 1000;
        const result = {
          limit: limits[index],
          ticks: (after[index].ticks - before[index].ticks) / seconds,
          steps: (after[index].steps - before[index].steps) / seconds,
          draws: (after[index].draws - before[index].draws) / seconds,
          raf: (after[index].callbacks - before[index].callbacks) / seconds,
        };
        console.log(JSON.stringify(result));
        assert.ok(result.ticks > 28 && result.ticks < 32, after[index].status);
        assert.ok(
          result.steps > 28 && result.steps < 32,
          "Performance counter must report actual C steps",
        );
        assert.ok(
          result.draws <= Math.min(limits[index] || Infinity, result.raf) + 2,
          "Network drawing bypassed render cap or RAF",
        );
        assert.ok(
          result.draws > Math.min(limits[index] || Infinity, result.raf) * 0.85,
          "Network drawing lost cadence",
        );
      }
    }
    assert.equal(await authority.evaluate(() => Module._WebGetPresentedFrames()), 0);
    assert.deepEqual(errors, []);
    assert.equal(authorityError, undefined);
    console.log(
      "PASS: network simulation stays at 30 Hz across render caps; authority needs no RAF or frames",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
