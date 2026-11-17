/* global Module, tm4Port */
import assert from "node:assert/strict";

import { eventually, runtime } from "../rooms/runtime.ts";
import { launchBrowser } from "./helpers/browser.mjs";

assert(
  process.env.TM4_DISC_DIR,
  "Set TM4_DISC_DIR to a local disc folder for the real-engine room check",
);
const mf = await runtime(true);
const browser = await launchBrowser();
try {
  const origin = (await mf.ready).origin;
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  const errors = [];
  for (const page of [host, guest]) page.on("pageerror", (error) => errors.push(error.message));
  await host.goto(origin);
  await host.locator("#create-player").fill("Host");
  await host.locator("#create-name").fill("Tournament");
  await host.locator("#create-form button").click();
  await host.waitForURL(/\/rooms\/[a-f0-9]{32}$/);
  // An unfinished FFA quota must not block the tournament settings form.
  await host.locator('[name="humanLimit"]').fill("");
  await host.locator('[name="modeId"]').selectOption("tournament");
  await host.locator('#settings-form button[type="submit"]').click();
  await host.locator("#room-mode").filter({ hasText: "Tournament" }).waitFor();
  const roomId = new URL(host.url()).pathname.split("/").pop();
  const view = async () =>
    (await (await host.request.get(`${origin}/api/rooms/${roomId}`)).json()).room;
  await guest.goto(host.url());
  await guest.locator("#join-player").fill("Guest");
  await guest.locator("#join-form button").click();
  let rejectedConfirmation = false;
  await guest.route("**/api/rooms/*/player", async (route) => {
    const request = route.request();
    if (!rejectedConfirmation && request.method() === "POST" && request.postDataJSON()?.ready) {
      rejectedConfirmation = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary confirmation failure" }),
      });
    } else await route.continue();
  });
  const frames = [];
  for (const page of [host, guest]) {
    await page.bringToFront();
    await page.locator("#room-player").waitFor();
    const frame = await (await page.locator("#room-player").elementHandle()).contentFrame();
    await frame.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
    await frame.waitForFunction(
      () => globalThis.tm4Port?.screen === "carsel" && tm4Port.menuReady,
      null,
      { timeout: 90000 },
    );
    await frame.locator("canvas").focus();
    await page.keyboard.press("ArrowRight", { delay: 150 });
    await page.keyboard.press("KeyX", { delay: 150 });
    await frame.waitForFunction(() => Module.ccall("WebSelectedCar", "string", [], []), null, {
      timeout: 10000,
    });
    if (page === guest) {
      await page
        .locator("#player-status")
        .filter({ hasText: "Temporary confirmation failure" })
        .waitFor();
      await frame.locator('#car-selection-status[data-phase="error"]').waitFor();
      assert.match(
        await frame.locator("#car-selection-status-message").textContent(),
        /Done to retry/,
      );
      const revision = await frame.evaluate(() => Module._WebCarSelectionRevision());
      // Let the 30 Hz menu sample key-up before pressing Done for a second time.
      await page.waitForTimeout(100);
      await page.keyboard.press("KeyX", { delay: 150 });
      await frame.waitForFunction(
        (previous) => Module._WebCarSelectionRevision() > previous,
        revision,
      );
    }
    frames.push(frame);
    if (page === host) {
      await frame.locator('#car-selection-status[data-phase="waiting"]').waitFor();
      assert.match(
        await frame.locator("#car-selection-status-message").textContent(),
        /Guest to choose/,
      );
      await page.screenshot({ path: "build/checks/tournament-waiting.png", fullPage: true });
    }
  }
  const confirmed = await eventually(
    view,
    (room) => room.participants.length === 2 && room.participants.every((p) => p.ready),
    15000,
  );
  assert(rejectedConfirmation, "Retry exercised a failed confirmation");
  for (const frame of frames) {
    await frame.locator('#car-selection-status[data-phase="ready"]').waitFor();
    assert.equal(
      await frame.locator("#car-selection-status-title").textContent(),
      "All cars confirmed",
    );
  }
  assert(confirmed.participants.every((p) => p.car));
  assert.equal(confirmed.capacity, 4);
  assert.equal(confirmed.freePlaces, 2);
  assert.equal(confirmed.match, null, "Selection does not allocate an FFA server");
  assert.equal(await host.locator("#room-car").count(), 0);
  assert.equal(await host.locator("#room-ready").count(), 0);
  assert(await host.locator("#start-match").isHidden());
  for (const frame of frames) assert.equal(await frame.evaluate(() => tm4Port.menuMode), 0);
  // Preparing the server must not leave a stale upload overlay on native selection.
  await host.bringToFront();
  await host.locator("#prepare-match").click();
  await eventually(view, (room) => room.match?.stage === "ready", 30000);
  await host.locator("#match-status").filter({ hasText: "Server ready" }).waitFor();
  assert(!(await frames[0].locator("#status").textContent()).includes("Server"));
  assert(await frames[0].locator("#status").isHidden());
  assert(await frames[0].locator("#car-selection-status").isVisible());
  assert(await frames[0].evaluate(() => tm4Port.menuReady));
  await host.locator("#cancel-preparation").click();
  await eventually(view, (room) => room.match === null);
  assert(await frames[0].locator("#status").isHidden());
  assert(await frames[0].evaluate(() => tm4Port.menuReady));
  console.log("PASS preparation completes and cancels without obscuring native car selection");
  // A delayed stop for the old match must not cancel the separate menu request.
  await host.bringToFront();
  await host.evaluate((roomId) => {
    document
      .getElementById("room-player")
      .contentWindow.postMessage(
        { type: "rm4-room", roomId, action: "stop", sessionId: crypto.randomUUID() },
        location.origin,
      );
  }, roomId);
  await frames[0].locator("canvas").focus();
  const revision = await frames[0].evaluate(() => Module._WebCarSelectionRevision());
  await host.keyboard.press("KeyX", { delay: 150 });
  await frames[0].waitForFunction(
    (previous) => Module._WebCarSelectionRevision() > previous,
    revision,
  );
  await host.screenshot({ path: "build/checks/tournament-room.png", fullPage: true });
  await guest.bringToFront();
  await frames[1].locator("canvas").focus();
  await guest.keyboard.press("KeyS", { delay: 150 });
  await eventually(
    view,
    (room) =>
      room.participants[0].ready &&
      !room.participants[1].ready &&
      room.participants[1].car === null,
  );
  await frames[0].locator('#car-selection-status[data-phase="waiting"]').waitFor();
  await frames[1].locator('#car-selection-status[data-phase="choosing"]').waitFor();
  await host.bringToFront();
  await host.locator('[name="modeId"]').selectOption("ffa");
  await host.locator('#settings-form button[type="submit"]').click();
  await eventually(
    view,
    (room) => room.modeId === "ffa" && room.participants.every((p) => !p.ready),
  );
  for (const frame of frames)
    await frame.waitForFunction(() => tm4Port.screen === "carsel" && tm4Port.menuReady);
  for (const frame of frames)
    await frame.locator('#car-selection-status[data-phase="choosing"]').waitFor();
  assert.equal(await host.locator("#room-car").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS two real engine menus confirm room roster, back clears selection, FFA opens a fresh native selection",
  );
} finally {
  await browser.close();
  await mf.dispose();
}
