/* global tm4Port, Module */
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { readyInLobby } from "./network_lobby.mjs";

const endpoint = process.env.TM4_MATCH_ENDPOINT;
const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
const delay = Number(process.env.TM4_CLOCK_OFFER_DELAY_MS ?? 900);
const freeze = Number(process.env.TM4_CLOCK_FREEZE_MS ?? 0);
assert(endpoint, "A fresh prediction-enabled match server is required");

const browser = await launchBrowser();
try {
  const [first, second] = await Promise.all(
    Array.from({ length: 2 }, () => browser.newPage({ viewport: { width: 800, height: 600 } })),
  );
  const errors = [];
  for (const page of [first, second]) page.on("pageerror", (error) => errors.push(error.message));
  const loaded = (page) =>
    page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
      polling: 100,
      timeout: 60_000,
    });

  const target = new URL(site);
  target.searchParams.set("match", endpoint);
  await first.goto(target.href);
  await first.locator("#car-lobby").waitFor({ state: "visible", timeout: 60000 });
  await second.bringToFront();
  await second.goto(target.href);
  await loaded(second);
  if (freeze) {
    for (const page of [first, second]) await page.evaluate(() => Module._WebSetRenderLimit(30));
  }
  if (delay) {
    await second.evaluate(async (delay) => {
      const { NetworkClient } = await import("/network/tm4_network.js");
      const update = NetworkClient.prototype.update;
      let held;
      NetworkClient.prototype.update = function () {
        const messages = JSON.parse(update.call(this));
        const index = messages.findIndex(({ type }) => type === "prediction_offer");
        if (index >= 0 && !held) {
          const [offer] = messages.splice(index, 1);
          held = { offer, until: performance.now() + delay };
          tm4Port.testClockOfferHeld = this.prediction_clock();
        }
        if (held?.offer && performance.now() >= held.until) {
          messages.unshift(held.offer);
          held.offer = null;
          tm4Port.testClockOfferDelivered = this.prediction_clock();
        }
        return JSON.stringify(messages);
      };
    }, delay);
    await Promise.all([first, second].map(readyInLobby));
    await second.waitForFunction(() => tm4Port.testClockOfferHeld !== undefined);
    const initial = await Promise.all(
      [first, second].map((page) => page.evaluate(() => tm4Port.netMatch?.tick)),
    );
    assert.deepEqual(initial, [0, 0], "A world started before the anchor was agreed");
    if (freeze) {
      const lifecycle = await second.context().newCDPSession(second);
      await lifecycle.send("Page.setWebLifecycleState", { state: "frozen" });
      await first.waitForTimeout(freeze);
      assert.equal(await first.evaluate(() => tm4Port.netMatch.tick), 0);
      await lifecycle.send("Page.setWebLifecycleState", { state: "active" });
    }
  }
  if (!delay) await Promise.all([first, second].map(readyInLobby));
  for (const page of [first, second])
    await page.waitForFunction(
      () =>
        tm4Port.netConfirmedTick >= 45 ||
        document.querySelector("#status").dataset.matchState === "error",
      null,
      { polling: 100, timeout: 12_000 },
    );
  const results = await Promise.all(
    [first, second].map((page) =>
      page.evaluate(() => ({
        tick: tm4Port.netConfirmedTick,
        offers: tm4Port.netDiagnostics.clockOffers,
        held: tm4Port.testClockOfferHeld,
        delivered: tm4Port.testClockOfferDelivered,
        visibility: document.visibilityState,
        status: document.querySelector("#status").textContent,
      })),
    ),
  );
  assert(results.every(({ offers, status }) => offers >= 1 && status.includes("Live prediction")));
  if (delay) {
    assert(
      results.every(({ offers }) => offers >= 2),
      "Expired proposal did not get replaced",
    );
    if (!freeze)
      assert(results[1].delivered - results[1].held > 12, "Initial offer did not actually expire");
  }
  assert.deepEqual(errors, []);
  console.log("PASS native prediction startup", JSON.stringify({ delay, freeze, results }));
} catch (error) {
  console.error("STARTUP ASSERTION", error);
  throw error;
} finally {
  await browser.close();
}
