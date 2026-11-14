/* Real Room + native Wasmtime authority: two matches in the same loaded pages. */
/* global Module, tm4Port */
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { nativeBridge } from "../rooms/native.ts";
import { eventually, runtime } from "../rooms/runtime.ts";
import { launchBrowser } from "./helpers/browser.mjs";
import { setPanelOpen } from "./helpers/player.mjs";

if (!process.env.TM4_DISC_DIR) throw new Error("Set TM4_DISC_DIR to your local disc folder");
const limits = { timeLimitTicks: 1200, fragLimit: 20 };
const fixture = resolve("build/room-tests/rematch-combat.json");
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
  resolve("build/diagnostic/server"),
  resolve("build/network-native/debug/tm4-deathmatch-server"),
  fixture,
  limits,
);
let mf, browser;
const errors = [];
const pages = [],
  frames = [],
  uploads = [[], [], []];
try {
  mf = await runtime(true, native.url);
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
    [0, 1, 2].map(() => browser.newContext({ viewport: { width: 1280, height: 1000 } })),
  );
  for (const [index, context] of contexts.entries()) {
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() === "PUT") uploads[index].push(request.url());
    });
  }
  const [host, guest, late] = pages;
  await host.goto(origin);
  await host.locator("#create-player").fill("Host");
  await host.locator("#create-name").fill("Same room rematch");
  await host.locator("#create-form button").click();
  await host.waitForURL(/\/rooms\/[a-f0-9]{32}$/);
  const roomUrl = host.url();
  const snapshot = async (page = host) =>
    page.evaluate(async () => (await (await fetch("/api" + location.pathname)).json()).room);
  const load = async (page, index) => {
    await page.locator("#match-panel").waitFor({ state: "visible" });
    const frame = await (await page.locator("#room-player").elementHandle()).contentFrame();
    await frame.waitForFunction(() => !document.getElementById("disc-folder").disabled, null, {
      timeout: 60000,
    });
    await frame.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
    await frame.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 60000 });
    await page.waitForFunction(() => !document.getElementById("room-car").disabled);
    await page.locator("#room-car").selectOption(index ? "Quatro" : "Calypso");
    await page.locator("#room-player").scrollIntoViewIfNeeded();
    await setPanelOpen(frame, "render-settings", true);
    await frame.locator("#render-scale").selectOption("1");
    await setPanelOpen(frame, "render-settings", false);
    await frame.evaluate(() => {
      globalThis.rematchMarker = crypto.randomUUID();
      globalThis.rematchModule = Module;
      globalThis.rematchEnds = [];
      const tick = Module._WebNetQueueTick;
      Module._WebNetQueueTick = (value) => {
        if (value === 120 && !Module._WebTestPrepareNetworkDuel(2500))
          throw new Error("Combat fixture failed");
        if (value >= 120 && value < 180)
          Module.ccall(
            "WebTestPlacePlayerProjectileTarget",
            "number",
            ["number", "number", "string"],
            [0, 1, "bullet"],
          );
        return tick(value);
      };
      new MutationObserver(() => {
        const state = tm4Port.netMatchServerState;
        if (state?.completion?.reasons && globalThis.rematchEnds.at(-1)?.digest !== state.digest)
          globalThis.rematchEnds.push(structuredClone(state));
      }).observe(document.getElementById("status"), {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    frames[index] = frame;
    return frame;
  };
  await guest.goto(roomUrl);
  await guest.locator("#join-player").fill("Guest");
  await guest.locator("#join-form button").click();
  await load(host, 0);
  await load(guest, 1);
  const markers = await Promise.all(
    frames.map((frame) => frame.evaluate(() => globalThis.rematchMarker)),
  );
  const ids = [],
    results = [];
  let members;
  for (let cycle = 0; cycle < 2; cycle++) {
    console.log("Starting browser cycle", cycle + 1);
    const activePages = cycle ? pages : pages.slice(0, 2);
    await host.locator("#prepare-match").click();
    await host.waitForFunction(() => !document.getElementById("room-ready").disabled, null, {
      timeout: 120000,
    });
    for (const page of activePages) await page.locator("#room-ready").click();
    await host.waitForFunction(() => !document.getElementById("start-match").disabled);
    const before = await snapshot();
    ids.push(before.match.id);
    await host.locator("#start-match").click();
    for (const frame of frames) {
      await frame.waitForFunction(
        () =>
          tm4Port.netMatch &&
          tm4Port.netDiagnostics?.transportActive &&
          tm4Port.netConfirmedTick >= 30 &&
          tm4Port.netMatchServerState?.completion.reasons === 0,
        null,
        { timeout: 90000 },
      );
      assert(
        (await frame.evaluate(() => tm4Port.netMatchServerState.scores)).every(
          (score) => score.frags === 0 && score.deaths === 0,
        ),
        "fresh match starts with zero authoritative scores",
      );
      if (cycle) {
        assert(
          await frame.evaluate(() => globalThis.rematchModule === Module),
          "same loaded runtime",
        );
        assert.equal(
          await frame.evaluate(() => tm4Port.netDiagnostics.recoveredTick),
          undefined,
          "match two is not an old recovery",
        );
      }
    }
    const credentials = await Promise.all(
      activePages.map(async (page) => (await snapshot(page)).match.credential),
    );
    assert(credentials.every((value) => typeof value === "string" && value.length === 64));
    assert.equal((await snapshot()).result, null, "old result clears at new start");
    const oldCar = await frames[0].evaluate(() => Module._WebTestCarHandle(1));
    await frames[0].waitForFunction(() => tm4Port.netConfirmedTick >= 121);
    await frames[0].locator("#canvas").click();
    await host.keyboard.down("e");
    await frames[0].waitForFunction(
      () => tm4Port.netMatchServerState?.scores[1]?.deaths === 1,
      null,
      { timeout: 20000 },
    );
    await host.keyboard.up("e");
    await frames[0].waitForFunction(
      () => tm4Port.netConfirmedTick > 300 && Module._WebTestCarHandle(1) > 0,
      null,
      { timeout: 20000 },
    );
    assert(
      await frames[0].evaluate((old) => Module._WebTestCarHandle(1) > old, oldCar),
      "respawn creates a fresh car lifetime",
    );
    assert.equal(await frames[0].evaluate(() => tm4Port.netMatchServerState.scores[0].frags), 1);
    if (!cycle) {
      await late.goto(roomUrl);
      await late.locator("#join-player").fill("Late");
      await late.locator("#join-form button").click();
      await load(late, 2);
      markers.push(await frames[2].evaluate(() => globalThis.rematchMarker));
      await late.locator("#room-ready").click();
      await frames[2].waitForFunction(
        () => Module._WebNetSlotMask() === 7 && tm4Port.netConfirmedTick > 300,
        null,
        { timeout: 30000 },
      );
      for (const frame of frames)
        await frame.waitForFunction(() => tm4Port.netMatchServerState?.remaining === 3);
      const head = await frames[1].evaluate(() => tm4Port.netConfirmedTick);
      await guest.locator("#reconnect-match").click();
      await frames[1].waitForFunction(
        (head) => tm4Port.netConfirmedTick > head && tm4Port.netDiagnostics?.recoveredTick > 0,
        head,
        { timeout: 30000 },
      );
      members = (await snapshot()).participants.map((row) => row.id);
    } else {
      assert.deepEqual(
        (await snapshot()).participants.map((row) => row.id),
        members,
        "room identities survive into match two",
      );
      assert.notEqual(ids[0], ids[1]);
      assert(
        credentials.every(
          (value) => value !== results[0].credentials[0] && value !== results[0].credentials[1],
        ),
        "new admission credentials",
      );
      for (const [index, frame] of frames.entries())
        assert.equal(
          await frame.evaluate(() => globalThis.rematchMarker),
          markers[index],
          "no page/frame reload or repeated disc selection",
        );
    }
    await eventually(
      snapshot,
      (room) => room.match === null && room.result?.matchId === ids[cycle],
      60000,
    );
    const room = await snapshot();
    assert.equal(native.starts, cycle + 1);
    assert.equal(native.stops, cycle + 1);
    assert.equal(native.active, 0, "no finished native process survives");
    assert(room.participants.every((row) => !row.ready));
    assert.deepEqual(room.result.completion, {
      tick: limits.timeLimitTicks,
      reasons: 1,
      winners: 1,
    });
    assert.deepEqual(
      room.result.participants.map((row) => [
        row.name,
        row.score.frags,
        row.score.deaths,
        row.winner,
      ]),
      [
        ["Host", 1, 0, true],
        ["Guest", 0, 1, false],
        ["Late", 0, 0, false],
      ],
    );
    for (const page of pages) {
      assert.deepEqual(
        (await snapshot(page)).result,
        room.result,
        "same authoritative result for every room member",
      );
      await page.locator("#results-panel").waitFor({ state: "visible" });
      assert.equal(await page.locator("#results-rows tr").count(), 3);
      assert.match(await page.locator("#results-reason").innerText(), /Time limit reached.*Host/);
    }
    for (const frame of frames) {
      const end = await frame.evaluate(() => globalThis.rematchEnds.at(-1));
      assert.deepEqual(end.completion, room.result.completion);
      for (const row of room.result.participants)
        assert.deepEqual(row.score, end.scores[row.identity.slot]);
      assert.deepEqual(
        await frame.evaluate(() =>
          Object.keys(sessionStorage).filter((key) => key.startsWith("tm4.resume.")),
        ),
        [],
        "completed recovery credentials removed",
      );
      assert.equal(
        await frame.evaluate(() => tm4Port.netMatch),
        undefined,
        "C match state released",
      );
    }
    await host
      .locator("#results-panel")
      .screenshot({ path: "build/room-tests/ffa-results-" + (cycle + 1) + ".png" });
    console.log("Completed browser cycle", cycle + 1);
    results.push({ result: room.result, credentials });
    // Reconnect this room identity in a second tab after the native server is gone.
    const returning = await contexts[1].newPage();
    await returning.goto(roomUrl);
    await returning.locator("#results-panel").waitFor({ state: "visible" });
    assert.deepEqual((await snapshot(returning)).result, room.result);
    await returning.close();
    for (const page of pages) await page.locator("#return-to-room").click();
    assert.equal(await host.locator("#prepare-match").isDisabled(), false);
    assert.equal(
      await host.locator("#results-panel").isVisible(),
      true,
      "last scoreboard remains available in room",
    );
  }
  assert.equal(uploads[1].length, 0);
  assert.equal(uploads[2].length, 0);
  assert(native.history.filter((entry) => entry.phase === "results").length >= 2);
  assert(!native.history.some((entry) => ["failed", "closed"].includes(entry.phase)));
  assert.deepEqual(errors, []);
  console.log(
    "PASS same loaded pages: two native FFA matches, lethal combat/respawn, late admission, reconnect, identical named authoritative results, retained room result, fresh session/credentials/zero scores and zero surviving servers",
  );
} catch (error) {
  console.error(
    "Browser states",
    await Promise.all(
      frames.map((frame) =>
        frame
          .evaluate(() => ({
            local: tm4Port.netMatch,
            confirmed: tm4Port.netMatchServerState,
            diagnostics: tm4Port.netDiagnostics,
            status: document.getElementById("status")?.textContent,
          }))
          .catch(String),
      ),
    ),
  );
  console.error(native.log);
  throw error;
} finally {
  await browser?.close();
  await mf?.dispose();
  await native.close();
}
