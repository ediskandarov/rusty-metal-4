/* global Module, tm4Port */
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { launchBrowser } from "./helpers/browser.mjs";
import { setPanelOpen } from "./helpers/player.mjs";

if (!process.env.TM4_DISC_DIR) throw new Error("Set TM4_DISC_DIR to your own disc folder");
const { nativeBridge } = await import("../rooms/native.ts");
const { runtime, eventually } = await import("../rooms/runtime.ts");
const fixture = resolve("build/room-tests/combat.json");
await Bun.write(
  fixture,
  JSON.stringify({
    actions: [
      { tick: 120, name: "duel", distance: 2500 },
      { tick: 120, name: "projectile", args: [0, 1], projectile: "bullet", until: 180 },
    ],
  }),
);
const native = await nativeBridge(
  resolve(process.env.TM4_SERVER_BUNDLE ?? "build/diagnostic/server"),
  resolve(process.env.TM4_SERVER_EXECUTABLE ?? "build/network-native/debug/tm4-deathmatch-server"),
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
  const contexts = await Promise.all(
    Array.from({ length: 2 }, () =>
      browser.newContext({ viewport: { width: 1280, height: 1000 } }),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [a, b] = pages;
  const uploads = [[], []];
  for (const [index, page] of pages.entries()) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() === "PUT") uploads[index].push(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") console.error("BROWSER", index, message.text());
    });
  }
  const load = async (page, car, resuming = false) => {
    const frame = await (await page.locator("#room-player").elementHandle()).contentFrame();
    await frame.waitForFunction(() => !document.getElementById("disc-folder").disabled, null, {
      timeout: 60000,
    });
    await frame.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
    await frame.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 60000 });
    if (!resuming) {
      await page.waitForFunction(() => !document.getElementById("room-car").disabled, null, {
        timeout: 120000,
      });
      await page.locator("#room-car").selectOption(car);
    }
    await page.locator("#room-player").scrollIntoViewIfNeeded();
    await setPanelOpen(frame, "render-settings", true);
    await frame.locator("#render-scale").selectOption("1");
    await setPanelOpen(frame, "render-settings", false);
    await frame.evaluate(() => {
      const step = Module._WebNetQueueTick;
      Module._WebNetQueueTick = (tick) => {
        if (tick === 120 && !Module._WebTestPrepareNetworkDuel(2500))
          throw new Error("Combat fixture placement failed");
        if (tick >= 120 && tick < 180)
          Module.ccall(
            "WebTestPlacePlayerProjectileTarget",
            "number",
            ["number", "number", "string"],
            [0, 1, "bullet"],
          );
        const result = step(tick);
        if (Module._WebTestRespawnState(1, 0) === 2)
          globalThis.roomTestWaiting = {
            due: Module._WebTestRespawnState(1, 1),
            state: structuredClone(tm4Port.netMatch),
          };
        return result;
      };
    });
    return frame;
  };
  const identity = (frame, slot) =>
    frame.evaluate(
      (slot) => [
        Module._WebNetParticipantIdentityPart(slot, 0),
        Module._WebNetParticipantIdentityPart(slot, 1),
      ],
      slot,
    );
  const sessions = [];
  const rooms = [];
  for (let session = 0; session < 2; ++session) {
    await a.goto(origin);
    await a.locator("#create-player").fill("Host");
    await a.locator("#create-name").fill("FFA lifecycle " + session);
    await a.locator("#create-form button").click();
    await a.waitForURL(/\/rooms\/[a-f0-9]{32}$/);
    const roomUrl = a.url();
    rooms.push(roomUrl);
    await b.goto(roomUrl);
    await b.locator("#join-player").fill("Guest");
    await b.locator("#join-form button").click();
    await b.locator("#match-panel").waitFor({ state: "visible" });
    const frames = [await load(a, "Calypso"), await load(b, "Quatro")];
    assert.equal(native.starts, session, "loading local discs must not allocate a server");
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
    sessions.push(
      await a.evaluate(
        async () => (await (await fetch("/api" + location.pathname)).json()).room.match.id,
      ),
    );
    await a.locator("#start-match").click();
    for (const frame of frames)
      await frame.waitForFunction(() => tm4Port.netConfirmedTick > 30, null, { timeout: 90000 });
    assert.deepEqual(
      await Promise.all(frames.map((frame) => frame.evaluate(() => tm4Port.netViewSlot))),
      [0, 1],
    );
    const originalId = await identity(frames[1], 1);
    const oldCar = await frames[0].evaluate(() => Module._WebTestCarHandle(1));
    for (const frame of frames)
      assert(
        await frame.evaluate(() =>
          tm4Port.netMatchServerState.scores.every(
            (score) => score.frags === 0 && score.deaths === 0,
          ),
        ),
      );
    await frames[0].waitForFunction(() => tm4Port.netMatch.tick >= 121, null, { timeout: 15000 });
    await frames[0].locator("#canvas").click();
    await a.keyboard.down("e");
    await frames[0].waitForFunction(
      () => tm4Port.netMatchServerState?.scores[1]?.deaths === 1,
      null,
      { timeout: 20000 },
    );
    await a.keyboard.up("e");
    await frames[0].waitForFunction(() => globalThis.roomTestWaiting, null, { timeout: 10000 });
    const waiting = await frames[0].evaluate(() => globalThis.roomTestWaiting);
    assert.equal(waiting.state.remaining, 1);
    assert.equal(waiting.state.roundFinished, false);
    assert.equal(waiting.state.nextMode, 0);
    for (const frame of frames) {
      await frame.waitForFunction(
        (due) => tm4Port.netConfirmedTick > due + 10 && Module._WebTestCarHandle(1) > 0,
        waiting.due,
        { timeout: 15000 },
      );
      const state = await frame.evaluate(() => ({
        match: tm4Port.netMatchServerState,
        serial: Module._WebTestCarHandle(1),
        model: tm4Port.cars.find((car) => car.player === 1)?.name,
        health: tm4Port.cars.find((car) => car.player === 1)?.health,
      }));
      assert.equal(state.match.remaining, 2);
      assert.equal(state.match.roundFinished, false);
      assert.equal(state.match.acceptsContinue, false);
      assert.equal(state.match.nextMode, 0);
      assert.deepEqual(state.match.scores.slice(0, 2), [
        { frags: 1, deaths: 0 },
        { frags: 0, deaths: 1 },
      ]);
      assert(state.serial > oldCar, "same participant receives a new car lifetime");
      assert.equal(state.model, "Quatro");
      assert(state.health > 1, "new car health is independent of the lethal fixture");
    }
    if (session === 0) {
      // Gameplay must outlive the setup HTTP deadline and recover its actual post-respawn results.
      await frames[0].waitForFunction(() => tm4Port.netConfirmedTick > 1000, null, {
        timeout: 60000,
      });
      const hostTick = await frames[0].evaluate(() => tm4Port.netConfirmedTick);
      await frames[0].evaluate(() => {
        globalThis.roomLifecycleMarker = true;
      });
      await a.locator("#reconnect-match").evaluate((button) => {
        button.click();
        button.click();
      });
      await frames[0].waitForFunction(
        (tick) => tm4Port.netConfirmedTick > tick && tm4Port.netDiagnostics?.recoveredTick > 0,
        hostTick,
        { timeout: 60000 },
      );
      assert(await frames[0].evaluate(() => globalThis.roomLifecycleMarker));
      assert.equal(await frames[0].locator("#status").getAttribute("data-match-state"), "playing");
      console.log(
        "PASS immediate repeated reconnect keeps the same loaded player and resumes confirmation",
      );
      await b.reload();
      await b.locator("#match-panel").waitFor({ state: "visible" });
      frames[1] = await load(b, "Quatro", true);
      await frames[1].waitForFunction(
        () =>
          tm4Port.netConfirmedTick > 1000 &&
          tm4Port.netDiagnostics?.recoveredTick > 0 &&
          !!tm4Port.netMatchServerState,
        null,
        { timeout: 60000 },
      );
      assert.deepEqual(await identity(frames[1], 1), originalId);
      assert.deepEqual(
        await frames[1].evaluate(() => tm4Port.netMatchServerState.scores.slice(0, 2)),
        [
          { frags: 1, deaths: 0 },
          { frags: 0, deaths: 1 },
        ],
      );
      console.log("PASS native socket beyond setup deadline and post-respawn participant recovery");
      // Two prepared players start the match; the third takes an available FFA place later.
      const thirdContext = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const third = await thirdContext.newPage();
      const thirdUploads = [];
      third.on("pageerror", (error) => errors.push(error.message));
      third.on("request", (request) => {
        if (request.method() === "PUT") thirdUploads.push(request.url());
      });
      try {
        await third.goto(roomUrl);
        await third.locator("#join-player").fill("Third");
        await third.locator("#join-form button").click();
        await third.locator("#match-panel").waitFor({ state: "visible" });
        const thirdFrame = await load(third, "Quatro");
        assert.equal(await third.locator("#room-ready").innerText(), "Join match");
        await third.locator("#room-ready").click();
        await thirdFrame.waitForFunction(
          () => tm4Port.netViewSlot === 2 && Module._WebNetSlotMask() === 7,
          null,
          { timeout: 60000 },
        );
        const admissionHead = await thirdFrame.evaluate(() => tm4Port.netMatch.tick);
        await thirdFrame.waitForFunction(
          (head) => tm4Port.netConfirmedTick >= head,
          admissionHead,
          {
            timeout: 15000,
          },
        );
        for (const frame of frames)
          await frame.waitForFunction(
            () => Module._WebNetSlotMask() === 7 && tm4Port.netMatchServerState?.remaining === 3,
            null,
            { timeout: 15000 },
          );
        const room = await third.evaluate(
          async () => (await (await fetch("/api" + location.pathname)).json()).room,
        );
        assert.equal(room.capacity, 8);
        assert.equal(room.participantCount, 3);
        assert.equal(room.freePlaces, 5);
        await eventually(
          async () =>
            (await (await fetch(origin + "/api/rooms")).json()).rooms.find(
              (entry) => entry.id === room.id,
            ),
          (entry) =>
            entry?.capacity === 8 && entry.participantCount === 3 && entry.freePlaces === 5,
        );
        assert.equal(await thirdFrame.evaluate(() => tm4Port.netMatch.scores.length), 8);
        assert.deepEqual(await identity(frames[1], 1), originalId);
        assert.equal(thirdUploads.length, 0, "late arrivals use their own disc without uploading");
        await third.locator("#leave-button").click();
        await third.waitForURL(origin + "/");
        for (const frame of frames)
          await frame.waitForFunction(
            () => Module._WebNetSlotMask() === 3 && tm4Port.netMatchServerState?.remaining === 2,
            null,
            { timeout: 15000 },
          );
        console.log(
          "PASS two prepared players start eight-place FFA; a third joins live and directory counts agree",
        );
      } finally {
        await thirdContext.close();
      }
    }
    await a.screenshot({
      path: "build/room-tests/native-match-" + session + ".png",
      fullPage: true,
    });
    await b.locator("#leave-button").click();
    await b.waitForURL(origin + "/");
    await frames[0].waitForFunction(
      () => Module._WebNetSlotMask() === 1 && tm4Port.netMatchServerState?.remaining === 1,
      null,
      { timeout: 15000 },
    );
    assert.equal(await frames[0].evaluate(() => tm4Port.netMatchServerState.roundFinished), false);
    await a.locator("#leave-button").click();
    await a.waitForURL(origin + "/");
    await eventually(
      async () => native.stops,
      (stops) => stops === session + 1,
      45000,
    );
    await eventually(
      async () => {
        const response = await fetch(new URL("/api" + new URL(roomUrl).pathname, origin));
        if (response.status === 404) return true;
        const room = (await response.json()).room;
        return room.participants.length === 0 && room.match === null;
      },
      (released) => released,
      10000,
    );
    assert.equal(
      native.history.filter((entry) => entry.phase === "results").length,
      0,
      "FFA does not synthesize a deferred round result",
    );
    console.log("PASS explicit departures and empty-room native resource cleanup", session + 1);
  }
  assert.notEqual(sessions[0], sessions[1]);
  assert.notEqual(rooms[0], rooms[1]);
  assert.equal(native.starts, 2);
  assert.equal(native.stops, 2);
  assert(uploads[0].length > 0);
  assert.equal(uploads[1].length, 0, "guests never upload disc resources");
  assert.deepEqual(errors, []);
  console.log(
    "PASS two native FFA sessions: real combat, fresh-car respawn, persistent results, reconnect, explicit leave and private resource cleanup. Automatic results/return to room remain deferred.",
  );
} catch (error) {
  console.error(native.log);
  throw error;
} finally {
  await browser?.close();
  await mf.dispose();
  await native.close();
}
