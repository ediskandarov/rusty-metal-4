/* global Module, tm4Port */
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { nativeBridge } from "../rooms/native.ts";
import { eventually, runtime } from "../rooms/runtime.ts";
import { launchBrowser } from "./helpers/browser.mjs";

assert(process.env.TM4_DISC_DIR, "Set TM4_DISC_DIR to your disc folder");
const fixture = resolve("build/room-tests/tournament-victory.json");
const waves = [360, 600, 840, 1080];
await Bun.write(
  fixture,
  JSON.stringify({ actions: waves.map((tick) => ({ tick, name: "opponents" })) }),
);
const native = await nativeBridge(
  resolve(process.env.TM4_SERVER_BUNDLE ?? "build/diagnostic/server"),
  resolve(process.env.TM4_SERVER_EXECUTABLE ?? "build/network-native/debug/tm4-deathmatch-server"),
  fixture,
);
const mf = await runtime(true, native.url);
const browser = await launchBrowser({
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--mute-audio",
  ],
});
const pages = [];
try {
  const origin = (await mf.ready).origin;
  for (let i = 0; i < 2; ++i) pages.push(await (await browser.newContext()).newPage());
  const [host, guest] = pages;
  const errors = [];
  for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
  await host.goto(origin);
  await host.locator("#create-player").fill("Host");
  await host.locator("#create-name").fill("Tournament battle");
  await host.locator("#create-form button").click();
  await host.waitForURL(/\/rooms\/[a-f0-9]{32}$/);
  await host.locator('[name="modeId"]').selectOption("tournament");
  await host.locator('#settings-form button[type="submit"]').click();
  await host.locator("#room-mode").filter({ hasText: "Tournament" }).waitFor();
  const roomId = new URL(host.url()).pathname.split("/").pop();
  const view = async () =>
    (await (await host.request.get(`${origin}/api/rooms/${roomId}`)).json()).room;
  await guest.goto(host.url());
  await guest.locator("#join-player").fill("Guest");
  await guest.locator("#join-form button").click();
  const load = async (page) => {
    await page.locator("#room-player").waitFor();
    const frame = await (await page.locator("#room-player").elementHandle()).contentFrame();
    await frame.waitForFunction(() => !document.getElementById("disc-folder").disabled);
    await frame.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
    await frame.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
    await frame.evaluate((waves) => {
      const step = Module._WebNetQueueTick;
      Module._WebNetQueueTick = (tick) => {
        if (waves.includes(tick)) Module._WebTestDefeatOpponents();
        return step(tick);
      };
    }, waves);
    return frame;
  };
  const frames = [];
  for (const page of pages) {
    await page.bringToFront();
    const frame = await load(page);
    frames.push(frame);
    await frame.waitForFunction(() => tm4Port.screen === "carsel" && tm4Port.menuReady);
    await frame.locator("canvas").focus();
    await page.keyboard.press("ArrowRight", { delay: 150 });
    await page.keyboard.press("KeyX", { delay: 150 });
    await frame.waitForFunction(() => Module.ccall("WebTournamentSelectedCar", "string", [], []));
  }
  await eventually(view, (room) => room.participants.every((p) => p.ready));
  await host.bringToFront();
  await host.locator("#prepare-match").click();
  await host.waitForFunction(
    () =>
      !document.getElementById("start-match").hidden &&
      !document.getElementById("start-match").disabled,
    null,
    {
      timeout: 120000,
    },
  );
  assert(
    (await view()).participants.every((p) => p.ready),
    "Upload must preserve native Done",
  );
  await host.locator("#start-match").click();
  for (const frame of frames)
    await frame.waitForFunction(() => tm4Port.netConfirmedTick > 120, null, { timeout: 120000 });
  console.log("PASS two native menus start the same tournament battle on Rust and two browsers");
  const states = await Promise.all(
    frames.map((frame) =>
      frame.evaluate(() => {
        Module._WebTestReadMatchState();
        return { match: tm4Port.match, net: tm4Port.netMatch, view: tm4Port.netViewSlot };
      }),
    ),
  );
  assert.deepEqual(
    states.map((s) => s.view),
    [0, 1],
  );
  for (const state of states) {
    assert(state.match.opponents > 0);
    assert.equal(state.net.unsupported, null);
    assert.equal(state.net.completion.reasons, 0);
  }
  const intruder = await (await browser.newContext()).newPage();
  await intruder.goto(host.url());
  assert(await intruder.locator("#join-form").isHidden(), "Tournament roster stays fixed");
  await frames[0].waitForFunction(() => tm4Port.netConfirmedTick > 700, null, { timeout: 40000 });
  await guest.reload();
  const recovered = await load(guest);
  await recovered.waitForFunction(() => tm4Port.netConfirmedTick > 720, null, { timeout: 120000 });
  assert.equal(await recovered.evaluate(() => tm4Port.netViewSlot), 1);
  assert.equal(await recovered.evaluate(() => tm4Port.menuReady), false);
  assert.deepEqual(errors, []);
  await host.screenshot({ path: "build/checks/tournament-match.png", fullPage: true });
  console.log("PASS tournament reconnect restores the same participant without car selection");
  const finished = await eventually(view, (room) => room.result?.completion.reasons === 4, 60000);
  assert.equal(finished.result.completion.winners, 3);
  assert(finished.result.participants.every((p) => p.winner));
  for (const page of pages) {
    await page.locator("#results-panel").waitFor();
    assert.match(await page.locator("#results-reason").innerText(), /Tournament battle won/);
    await page.locator("#return-to-room").click();
    const frame = await (await page.locator("#room-player").elementHandle()).contentFrame();
    await frame.waitForFunction(() => tm4Port.menuReady && tm4Port.screen === "carsel");
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS native AI and boss defeat produces team results and returns both players to the room",
  );
} catch (error) {
  for (const [i, page] of pages.entries()) {
    console.error(
      "ROOM",
      i,
      await page
        .locator("body")
        .innerText()
        .catch(() => "closed"),
    );
    const frame = await page
      .locator("#room-player")
      .elementHandle()
      .then((h) => h?.contentFrame())
      .catch(() => null);
    if (frame)
      console.error(
        "PLAYER",
        await frame
          .evaluate(() => ({
            status: tm4Port.status,
            error: tm4Port.error,
            net: tm4Port.netMatch,
            confirmed: tm4Port.netConfirmedTick,
          }))
          .catch(() => null),
      );
  }
  throw error;
} finally {
  await browser.close();
  await mf.dispose();
  await native.close();
}
