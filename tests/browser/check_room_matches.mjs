import assert from "node:assert/strict";
import { resolve } from "node:path";

import { launchBrowser } from "./helpers/browser.mjs";
/* global Module, tm4Port */
import { togglePanel } from "./helpers/player.mjs";

if (!process.env.TM4_DISC_DIR) throw new Error("Set TM4_DISC_DIR to your own disc folder");
const { nativeBridge } = await import("../rooms/native.ts");
const { runtime } = await import("../rooms/runtime.ts");
const fixture = resolve("build/room-tests/combat.json");
await Bun.write(fixture, JSON.stringify({ actions: [{ tick: 120, name: "duel", distance: 500 }] }));
const native = await nativeBridge(
  resolve("build/diagnostic/server"),
  resolve("build/network-native/debug/tm4-deathmatch-server"),
  fixture,
);
const mf = await runtime(true, native.url);
let browser;
const errors = [];
try {
  const origin = (await mf.ready).origin;
  browser = await launchBrowser({
    args: [
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--mute-audio",
    ],
  });
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 1000 } }),
    browser.newContext({ viewport: { width: 1280, height: 1000 } }),
  ]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [a, b] = pages;
  const uploads = [[], []];
  for (const [index, page] of pages.entries()) {
    page.on("response", (response) => {
      if (response.status() >= 400) console.error("HTTP", response.status(), response.url());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() === "PUT") uploads[index].push(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") console.error("BROWSER", index, message.text());
    });
  }
  await a.goto(origin);
  await a.locator("#create-player").fill("Host");
  await a.locator("#create-name").fill("Native lifecycle");
  await a.locator("#create-form button").click();
  await a.waitForURL(/\/rooms\/[a-f0-9]{32}$/);
  const roomUrl = a.url();
  await b.goto(roomUrl);
  await b.locator("#join-player").fill("Guest");
  await b.locator("#join-form button").click();
  await b.locator("#match-panel").waitFor({ state: "visible" });
  const frames = [];
  for (const [index, page] of pages.entries()) {
    const locator = page.frameLocator("#room-player");
    await locator.locator("#disc-folder").waitFor();
    const frame = await (await page.locator("#room-player").elementHandle()).contentFrame();
    frames.push(frame);
    await frame.waitForFunction(() => !document.getElementById("disc-folder").disabled);
    await locator.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
    await page.waitForFunction(() => !document.getElementById("room-car").disabled, null, {
      timeout: 120000,
    });
    await page.locator("#room-car").selectOption(index ? "Quatro" : "Calypso");
    await page.locator("#room-player").scrollIntoViewIfNeeded();
    await togglePanel(frame, "render-settings");
    await frame.locator("#render-scale").selectOption("1");
    await togglePanel(frame, "render-settings");
    await frame.evaluate(() => {
      const queue = Module._WebNetQueueTick;
      Module._WebNetQueueTick = (tick) => {
        if (tick === 120 && !Module._WebTestPrepareNetworkDuel(500))
          throw new Error("Combat fixture placement failed");
        return queue(tick);
      };
    });
  }
  console.log("Both local discs loaded");
  assert.equal(native.starts, 0, "Browsing/loading local discs must not allocate a server");
  const sessions = [];
  for (let round = 0; round < 2; round++) {
    console.log("Preparing native match", round + 1);
    await a.locator("#prepare-match").click();
    await a.waitForFunction(
      () =>
        !document.getElementById("room-ready").disabled ||
        document.getElementById("player-status").textContent.startsWith("Error:"),
      null,
      { timeout: 120000 },
    );
    assert(
      !(await a.locator("#room-ready").isDisabled()),
      await a.locator("#player-status").innerText(),
    );
    for (const page of pages) await page.locator("#room-ready").click();
    await a.waitForFunction(() => !document.getElementById("start-match").disabled);
    const state = await a.evaluate(
      async () => (await (await fetch("/api" + location.pathname)).json()).room,
    );
    sessions.push(state.match.id);
    console.log("Starting native match", round + 1);
    await a.locator("#start-match").click();
    for (const frame of frames)
      await frame.waitForFunction(() => globalThis.tm4Port?.netConfirmedTick > 30, null, {
        timeout: 90000,
      });
    assert.deepEqual(
      await Promise.all(frames.map((frame) => frame.evaluate(() => tm4Port.netViewSlot))),
      [0, 1],
    );
    if (round === 0) {
      // Exceed the setup HTTP deadline: gameplay sockets must stay alive independently.
      await frames[0].waitForFunction(() => tm4Port.netConfirmedTick > 1000, null, {
        timeout: 60000,
      });
      await b.reload();
      await b.locator("#match-panel").waitFor({ state: "visible" });
      await b.frameLocator("#room-player").locator("#disc-folder").waitFor();
      const resumed = await (await b.locator("#room-player").elementHandle()).contentFrame();
      await resumed.waitForFunction(() => !document.getElementById("disc-folder").disabled);
      await resumed.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
      await resumed.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
        timeout: 60000,
      });
      await b.locator("#room-player").scrollIntoViewIfNeeded();
      await togglePanel(resumed, "render-settings");
      await resumed.locator("#render-scale").selectOption("1");
      await togglePanel(resumed, "render-settings");
      await resumed.waitForFunction(() => tm4Port.netConfirmedTick > 1000, null, {
        timeout: 60000,
      });
      assert.equal(await resumed.evaluate(() => tm4Port.netViewSlot), 1);
      await resumed.evaluate(() => {
        const queue = Module._WebNetQueueTick;
        Module._WebNetQueueTick = (tick) => {
          if (tick === 120 && !Module._WebTestPrepareNetworkDuel(500))
            throw new Error("Combat fixture placement failed");
          return queue(tick);
        };
      });
      frames[1] = resumed;
      console.log("PASS live socket beyond setup deadline and native participant reconnect");
    }
    await a.screenshot({
      path: "build/room-tests/native-match-" + round + ".png",
      fullPage: true,
    });
    await frames[0].waitForFunction(() => tm4Port.netMatch?.tick >= 121, null, {
      timeout: 15000,
    });
    await a.locator("#room-player").scrollIntoViewIfNeeded();
    await frames[0].locator("#canvas").click();
    await a.keyboard.down("e");
    await frames[0].waitForFunction(() => tm4Port.netMatchServerState?.roundFinished, null, {
      timeout: 20000,
    });
    await a.keyboard.up("e");
    assert.equal(await frames[0].evaluate(() => tm4Port.netMatchServerState.winner), 0);
    await frames[0].waitForFunction(() => tm4Port.netMatchServerState?.acceptsContinue, null, {
      timeout: 15000,
    });
    await a.keyboard.down("x");
    await a.waitForFunction(
      () => document.getElementById("match-status").textContent.includes("Match finished"),
      null,
      { timeout: 20000 },
    );
    await a.keyboard.up("x");
    for (const page of pages) {
      assert.equal(page.url(), roomUrl);
      assert.equal(await page.locator("#participants li").count(), 2);
      assert.equal(await page.locator("#room-ready").innerText(), "Ready");
    }
    assert.equal(native.stops, round + 1, "Native process must be released after the real result");
    assert.equal(native.history.filter((entry) => entry.phase === "results").length, round + 1);
  }
  assert.notEqual(sessions[0], sessions[1]);
  assert(uploads[0].length > 0);
  assert.equal(uploads[1].length, 0, "Guests never upload disc resources");
  assert.deepEqual(errors, []);
  console.log(
    "PASS two independent website identities loaded local discs, selected cars, played two real native matches, received engine results and returned to the same room with two server processes released. Diagnostic fixture positions a lethal duel; HTTP/DO/player/Lightyear/native completion are real. Cloudflare containers were not deployed.",
  );
} catch (error) {
  console.error(native.log);
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) {
      console.error(
        await page
          .locator("#match-status")
          .textContent()
          .catch(() => ""),
        await page
          .locator("#player-status")
          .textContent()
          .catch(() => ""),
      );
      for (const frame of page.frames())
        console.error(
          await frame
            .evaluate(() => ({
              url: location.href,
              startup: document.getElementById("startup-progress")?.textContent,
              status: document.getElementById("status")?.textContent,
              tick: globalThis.tm4Port?.netConfirmedTick,
              state: globalThis.tm4Port?.netMatchServerState,
            }))
            .catch(() => null),
        );
    }
  throw error;
} finally {
  await browser?.close();
  await mf.dispose();
  await native.close();
}
