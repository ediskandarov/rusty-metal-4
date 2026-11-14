/* global tm4Port */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

import { launchBrowser } from "./helpers/browser.mjs";
import { closeSettings, setPanelOpen } from "./helpers/player.mjs";
import { readyInLobby } from "./network_lobby.mjs";

const site = new URL(process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/");
assert(process.env.TM4_MATCH_ENDPOINT, "Start a fresh local two-player authority first");
site.searchParams.set("match", process.env.TM4_MATCH_ENDPOINT);
const browser = await launchBrowser({
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--mute-audio",
  ],
});
const errors = [];
try {
  const pages = await Promise.all(
    Array.from({ length: 2 }, () => browser.newPage({ viewport: { width: 1280, height: 800 } })),
  );
  for (const page of pages) {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/network/tm4_network.js", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body:
          (await response.text()) +
          `
        const latencyUpdate = NetworkClient.prototype.update;
        const latencyConnected = NetworkClient.prototype.connected;
        const latencyDiagnostics = NetworkClient.prototype.diagnostics;
        NetworkClient.prototype.update = function() {
          globalThis.latencyTestClient = this;
          return latencyUpdate.call(this);
        };
        NetworkClient.prototype.connected = function() {
          if (globalThis.latencyTestDisconnect) {
            globalThis.latencyTestDisconnect = false;
            return false;
          }
          return latencyConnected.call(this);
        };
        NetworkClient.prototype.diagnostics = function() {
          const raw = latencyDiagnostics.call(this);
          const value = JSON.parse(raw);
          globalThis.latencyUnknownObserved ||= value.rttSamples === 0 && value.rttMs === null;
          if (globalThis.latencyFrozenDiagnostics) return globalThis.latencyFrozenDiagnostics;
          return raw;
        };
      `,
      });
    });
    await page.goto(site.href);
    await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 60000 });
    assert.equal(await page.locator("#network-latency").isHidden(), true, "no ping before play");
    await setPanelOpen(page, "render-settings", true);
    await page.locator("#render-scale").selectOption("1");
    await closeSettings(page);
    await readyInLobby(page);
  }
  const [page] = pages;
  for (const client of pages)
    await client.waitForFunction(
      () =>
        tm4Port.netDiagnostics?.transportActive &&
        tm4Port.netDiagnostics.transport?.rttSamples > 10,
      null,
      { timeout: 90000 },
    );
  await page.waitForFunction(() =>
    /^Ping \(RTT\) \d+ ms$/.test(document.getElementById("network-latency").value),
  );
  const baseline = await page.evaluate(() => tm4Port.netDiagnostics.transport.rttMs);
  await page.evaluate(() => globalThis.latencyTestClient.condition(90, 0));
  await page.waitForFunction(
    (baseline) => tm4Port.netDiagnostics.transport.rttMs > baseline + 45,
    baseline,
    { timeout: 30000 },
  );
  const conditionedSamples = await page.evaluate(() => tm4Port.netDiagnostics.transport.rttSamples);
  await page.waitForFunction(
    (samples) => tm4Port.netDiagnostics.transport.rttSamples >= samples + 50,
    conditionedSamples,
    { timeout: 15000 },
  );
  const delayed = await page.evaluate(() => tm4Port.netDiagnostics.transport.rttMs);
  assert(
    await page.evaluate(() => globalThis.latencyUnknownObserved),
    "initial LinkStats zero must be unknown",
  );
  const badge = await page.locator("#network-latency").boundingBox();
  const gear = await page.locator("#settings-toggle").boundingBox();
  assert(badge.x + badge.width < gear.x, "ping must fit beside the settings button");
  await mkdir("build/checks", { recursive: true });
  await page.screenshot({ path: "build/checks/network-latency-compact.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowBadge = await page.locator("#network-latency").boundingBox();
  const narrowGear = await page.locator("#settings-toggle").boundingBox();
  assert(narrowBadge.x >= 0 && narrowBadge.x + narrowBadge.width < narrowGear.x);
  await page.setViewportSize({ width: 1280, height: 800 });
  await setPanelOpen(page, "render-settings", true);
  await page.locator("#render-fps").check();
  await closeSettings(page);
  await page.waitForFunction(() =>
    document.querySelector("#performance-ping polyline").getAttribute("points")?.includes(" "),
  );
  assert.match(
    await page.locator("#performance-ping .performance-legend").innerText(),
    /RTT scale .* ms/,
  );
  assert.equal(
    await page.locator("#network-latency").isHidden(),
    true,
    "expanded graph replaces compact ping",
  );
  assert.equal(await page.locator("#performance-ping").isVisible(), true);
  await page.screenshot({ path: "build/checks/network-latency.png" });

  await page.evaluate(() => {
    globalThis.latencyFrozenDiagnostics = globalThis.latencyTestClient.diagnostics();
  });
  await page.waitForFunction(
    () => document.getElementById("network-latency").value.endsWith("(stale)"),
    null,
    { timeout: 6000 },
  );
  await page.evaluate(() => {
    globalThis.latencyFrozenDiagnostics = undefined;
  });
  await page.waitForFunction(() =>
    /^Ping \(RTT\) \d+ ms$/.test(document.getElementById("network-latency").value),
  );

  const previous = await page.evaluate(() => {
    globalThis.latencyOldClient = globalThis.latencyTestClient;
    globalThis.latencyTestDisconnect = true;
    return tm4Port.netConfirmedTick;
  });
  await page.waitForFunction(() => !tm4Port.netDiagnostics.transportActive);
  await page.locator("#network-latency").waitFor({ state: "hidden" });
  await page.locator("#performance-ping").waitFor({ state: "hidden" });
  await page.waitForFunction(
    (previous) =>
      globalThis.latencyTestClient !== globalThis.latencyOldClient &&
      tm4Port.netDiagnostics.transportActive &&
      tm4Port.netConfirmedTick > previous &&
      tm4Port.netDiagnostics.transport.rttSamples > 0,
    previous,
    { timeout: 90000 },
  );
  await page.waitForFunction(() =>
    /^Ping \(RTT\) \d+ ms$/.test(document.getElementById("network-latency").value),
  );
  const recovered = await page.evaluate(() => tm4Port.netDiagnostics.transport.rttMs);
  assert(
    delayed > baseline + 45,
    "90 ms incoming transport delay must meaningfully increase actual Ping/Pong RTT",
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    JSON.stringify({
      local: true,
      baselineRttMs: baseline,
      incomingDelayMs: 90,
      delayedRttMs: delayed,
      recoveredRttMs: recovered,
      staleAndReconnect: "passed",
    }),
  );
} finally {
  await browser.close();
}
