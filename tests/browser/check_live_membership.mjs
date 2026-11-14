import assert from "node:assert/strict";
import { resolve } from "node:path";

import { launchBrowser } from "./helpers/browser.mjs";
import { setPanelOpen } from "./helpers/player.mjs";

/* global Module, tm4Port */
/* Ordinary room flows against the actual Worker, native authority and browser simulation. */
if (!process.env.TM4_DISC_DIR) throw new Error("Set TM4_DISC_DIR to your local disc folder");
const { nativeBridge } = await import("../rooms/native.ts");
const { runtime } = await import("../rooms/runtime.ts");
const ffa = process.env.TM4_TEST_FFA === "1";
const actions = ffa
  ? Array.from({ length: 22 }, (_, index) => ({
      tick: 120 + index * 180,
      name: "kill",
      args: [0],
    }))
  : [];
const fixture = ffa ? resolve("build/room-tests/ffa-actions.json") : undefined;
if (fixture) await Bun.write(fixture, JSON.stringify({ actions }));
const native = await nativeBridge(
  resolve("build/diagnostic/server"),
  resolve("build/network-native/debug/tm4-deathmatch-server"),
  fixture,
);
let mf;
let browser;
const errors = [];
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
    Array.from({ length: 4 }, () =>
      browser.newContext({ viewport: { width: 1280, height: 1000 } }),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const [index, page] of pages.entries()) {
    page.on("pageerror", (error) => {
      errors.push(`${index}: ${error.message}`);
      console.error("PAGE", index, error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error") console.error("BROWSER", index, message.text());
    });
  }
  const [host, guest, third, late] = pages;
  await host.goto(origin);
  await host.locator("#create-player").fill("Host");
  await host.locator("#create-name").fill("Live membership");
  await host.locator("#create-form button").click();
  await host.waitForURL(/\/rooms\/[a-f0-9]{32}$/);
  const roomUrl = host.url();
  const join = async (page, name) => {
    await page.goto(roomUrl);
    await page.locator("#join-player").fill(name);
    await page.locator("#join-form button").click();
    await page.locator("#match-panel").waitFor({ state: "visible" });
  };
  await join(guest, "Guest");
  await join(third, "Third");
  const load = async (page) => {
    const frame = await (await page.locator("#room-player").elementHandle()).contentFrame();
    await frame.waitForFunction(() => !document.getElementById("disc-folder").disabled, null, {
      timeout: 60000,
    });
    await frame.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
    await page.waitForFunction(() => !document.getElementById("room-car").disabled, null, {
      timeout: 120000,
    });
    await page.locator("#room-car").selectOption("Orbital");
    await page.locator("#room-player").scrollIntoViewIfNeeded();
    await setPanelOpen(frame, "render-settings", true);
    await frame.locator("#render-scale").selectOption("1");
    await setPanelOpen(frame, "render-settings", false);
    if (ffa)
      await frame.evaluate(async (actions) => {
        const trace = (globalThis.ffaTrace = { rows: {}, restores: [] });
        const step = Module._WebNetQueueTick;
        Module._WebNetQueueTick = (tick) => {
          for (const action of actions)
            if (action.tick === tick) {
              if (!Module._WebTestKillParticipant(action.args[0]))
                throw new Error("FFA kill fixture rejected");
            }
          const result = step(tick);
          trace.rows[tick + 1] = {
            car: Module._WebTestCarHandle(0),
            model: Module._WebTestRespawnState(0, 4),
            pending: Module._WebTestRespawnState(0, 0),
            due: Module._WebTestRespawnState(0, 1),
            scores: structuredClone(tm4Port.netMatch?.scores),
            next: tm4Port.netMatch?.nextMode,
            finished: tm4Port.netMatch?.roundFinished,
          };
          return result;
        };
        const { NetworkClient } = await import(
          new URL("network/tm4_network.js", document.baseURI).href
        );
        const update = NetworkClient.prototype.update;
        NetworkClient.prototype.update = function () {
          if (this.connected() && !this.ffaConditioned) {
            this.condition(90, 8);
            this.ffaConditioned = true;
          }
          const bridge = globalThis.tm4LivePrediction;
          if (bridge && !bridge.ffaObserved) {
            bridge.ffaObserved = true;
            const restore = bridge.restore_live_tick;
            bridge.restore_live_tick = (tick) => {
              const from = tm4Port.netMatch.tick;
              const result = restore(tick);
              trace.restores.push({ from, tick, result });
              return result;
            };
          }
          return update.call(this);
        };
      }, actions);
    return frame;
  };
  const frames = [];
  for (const page of pages.slice(0, 3)) frames.push(await load(page));
  await frames[0].evaluate(async () => {
    const { NetworkClient } = await import(
      new URL("network/tm4_network.js", document.baseURI).href
    );
    const update = NetworkClient.prototype.update;
    const trace = (globalThis.membershipRollbackTrace = { plans: [], restores: [], applied: [] });
    NetworkClient.prototype.update = function () {
      const bridge = globalThis.tm4LivePrediction;
      if (bridge && !bridge.membershipObserved) {
        bridge.membershipObserved = true;
        const restore = bridge.restore_live_tick;
        bridge.restore_live_tick = (tick) => {
          const from = tm4Port.netMatch.tick;
          const result = restore(tick);
          trace.restores.push({
            tick,
            from,
            result,
            mask: Module._WebNetSlotMask(),
            car: Module._WebTestCarHandle(3),
          });
          return result;
        };
        const apply = bridge.apply_live_membership;
        bridge.apply_live_membership = (tick, json) => {
          const result = apply(tick, json);
          trace.applied.push({
            tick,
            changes: JSON.parse(json),
            mask: Module._WebNetSlotMask(),
            car: Module._WebTestCarHandle(3),
            result,
          });
          return result;
        };
      }
      const raw = update.call(this);
      for (const message of JSON.parse(raw))
        if (message.type === "membership") trace.plans.push(message);
      return raw;
    };
  });
  console.log("Initial three local discs loaded");
  await host.locator("#prepare-match").click();
  await host.waitForFunction(() => !document.getElementById("room-ready").disabled, null, {
    timeout: 120000,
  });
  for (const page of pages.slice(0, 3)) await page.locator("#room-ready").click();
  await host.waitForFunction(() => !document.getElementById("start-match").disabled);
  await host.locator("#start-match").click();
  try {
    for (const frame of frames)
      await frame.waitForFunction(() => globalThis.tm4Port?.netConfirmedTick > 30, null, {
        timeout: 30000,
      });
  } catch (error) {
    const states = await Promise.all(
      frames.map((frame) =>
        frame.evaluate(() => ({
          text: document.body.innerText,
          compatibility: tm4Port.compatibility,
          net: tm4Port.netDiagnostics,
          state: tm4Port.netSession,
        })),
      ),
    );
    console.log("PLAYER STATES", JSON.stringify(states));
    throw error;
  }
  if (ffa) {
    await frames[1].locator("canvas").click();
    await frames[1].waitForFunction(() => tm4Port.netMatch.tick >= 201, null, {
      timeout: 15000,
      polling: 5,
    });
    for (let pulse = 0; pulse < 16; ++pulse) {
      await guest.keyboard.down("ArrowRight");
      await new Promise((resolve) => setTimeout(resolve, 35));
      await guest.keyboard.up("ArrowRight");
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    for (const frame of frames)
      await frame.waitForFunction(() => tm4Port.netConfirmedTick > 222, null, { timeout: 20000 });
    const observed = await frames[0].evaluate(() => globalThis.ffaTrace);
    assert.equal(observed.rows[121].car, 0);
    assert.equal(observed.rows[121].due, 210);
    assert(observed.rows[211].car > observed.rows[120].car);
    assert.equal(observed.rows[211].scores[0].deaths, 1);
    assert(Object.values(observed.rows).every((row) => !row.finished && !row.next));
    assert(
      observed.restores.some(
        (restore) => restore.result && restore.from > 210 && restore.tick <= 210,
      ),
      JSON.stringify(observed.restores),
    );
    console.log(
      "PASS automatic FFA respawn and real Lightyear rollback across tick 210",
      JSON.stringify(observed.restores),
    );
  }
  const identity = async (frame, slot) =>
    frame.evaluate((slot) => {
      const lo = Module._WebNetParticipantIdentityPart(slot, 0) >>> 0,
        hi = Module._WebNetParticipantIdentityPart(slot, 1) >>> 0;
      return ((BigInt(hi) << 32n) | BigInt(lo)).toString(16).padStart(16, "0");
    }, slot);
  const initial = await Promise.all(frames.map((frame, slot) => identity(frame, slot)));
  await host.waitForFunction(
    () => document.getElementById("match-status").textContent.includes("New players can join"),
    null,
    { timeout: 15000 },
  );
  await join(late, "Late");
  let lateFrame = await load(late);
  if (ffa) await late.locator("#room-car").selectOption("Pizza Boy");
  assert.equal(await late.locator("#room-ready").innerText(), "Join match");
  await late.locator("#room-ready").click();
  // Observe C prediction crossing the announced admission while the authority
  // is still behind it, then lose only the preparing client's native socket.
  // The trace wraps bridge calls for observation; Lightyear owns every restore.
  await frames[0].waitForFunction(() => Module._WebNetSlotMask() === 15, null, {
    timeout: 15000,
    polling: 5,
  });
  const predicted = await frames[0].evaluate(() => {
    const trace = globalThis.membershipRollbackTrace;
    return {
      event: trace.plans.find((plan) => plan.changes.some((change) => change.kind === "admit")),
      head: tm4Port.netMatch.tick,
    };
  });
  assert(predicted.event && predicted.head > predicted.event.tick);
  const pendingRoom = await late.evaluate(
    async () => (await (await fetch("/api" + location.pathname)).json()).room,
  );
  const canceledCredential = pendingRoom.match.credential;
  await lateFrame.goto(lateFrame.url());
  await frames[0].waitForFunction(
    (tick) => Module._WebNetSlotMask() === 7 && tm4Port.netConfirmedTick > tick + 5,
    predicted.event.tick,
    { timeout: 20000 },
  );
  const rollback = await frames[0].evaluate(() => globalThis.membershipRollbackTrace);
  assert(
    rollback.plans.some((plan) => plan.tick === predicted.event.tick && plan.changes.length === 0),
    JSON.stringify(rollback),
  );
  assert(
    rollback.restores.some(
      (restore) =>
        restore.result &&
        restore.tick <= predicted.event.tick &&
        restore.from > predicted.event.tick &&
        restore.mask === 7 &&
        restore.car === 0,
    ),
    JSON.stringify(rollback),
  );
  assert(
    rollback.applied.some(
      (event) => event.tick === predicted.event.tick && event.mask === 15 && event.car > 0,
    ),
    JSON.stringify(rollback),
  );
  const cancellation = await late.waitForFunction(
    async () => {
      const room = (await (await fetch("/api" + location.pathname)).json()).room;
      return room.match.endpoint === null && room.match.credential === null && room.you !== null
        ? room
        : null;
    },
    null,
    { timeout: 20000 },
  );
  const canceledRoom = await cancellation.jsonValue();
  await cancellation.dispose();
  assert.equal(canceledRoom.you, pendingRoom.you);
  assert.equal(canceledRoom.match.credential, null);
  lateFrame = await load(late);
  await late.waitForFunction(() => !document.getElementById("room-ready").disabled);
  await late.locator("#room-ready").click();
  const retriedRoom = await late.evaluate(
    async () => (await (await fetch("/api" + location.pathname)).json()).room,
  );
  assert.equal(retriedRoom.you, pendingRoom.you);
  assert.notEqual(retriedRoom.match.credential, canceledCredential);
  console.log(
    "PASS real Lightyear cancellation rollback after predicted admission, authoritative room cleanup and same-member retry",
    JSON.stringify({
      event: predicted.event.tick,
      predicted: predicted.head,
      restores: rollback.restores,
    }),
  );
  await lateFrame.waitForFunction(() => globalThis.tm4Port?.netConfirmedTick > 30, null, {
    timeout: 90000,
  });
  await frames[0].waitForFunction(() => Module._WebNetSlotMask() === 15, null, {
    timeout: 15000,
  });
  await lateFrame.waitForFunction(
    () => Module._WebNetSlotMask() === 15 && tm4Port.netViewSlot === 3,
    null,
    { timeout: 15000 },
  );
  const admissionHead = await lateFrame.evaluate(() => tm4Port.netMatch.tick);
  await lateFrame.waitForFunction((head) => tm4Port.netConfirmedTick >= head, admissionHead, {
    timeout: 15000,
  });
  const slot = await lateFrame.evaluate(() => tm4Port.netViewSlot);
  assert.equal(slot, 3);
  const oldId = await identity(lateFrame, slot);
  assert.notEqual(oldId, predicted.event.changes[0].identity.participant);
  const oldToken = await lateFrame.evaluate(() => {
    const key = Object.keys(sessionStorage).find((key) => key.startsWith("tm4.resume."));
    return sessionStorage.getItem(key);
  });
  assert(oldToken);
  console.log("Late participant admitted", slot, oldId);
  if (ffa)
    await frames[0].waitForFunction(
      () =>
        Module._WebTestRespawnState(0, 0) === 2 &&
        Module._WebTestRespawnState(0, 1) - tm4Port.netMatch.tick > 45,
      null,
      { timeout: 15000, polling: 5 },
    );
  await late.locator("#leave-button").click();
  await late.waitForURL(origin + "/");
  await frames[0].waitForFunction(() => Module._WebNetSlotMask() === 7, null, { timeout: 15000 });
  if (ffa)
    assert.equal(
      await frames[0].evaluate(() => Module._WebTestRespawnState(0, 0)),
      2,
      "departure committed while another participant waited to respawn",
    );
  console.log("Explicit departure committed without ending the other players");
  await join(late, "Fresh entry");
  lateFrame = await load(late);
  await late.locator("#room-ready").click();
  await lateFrame.waitForFunction(() => globalThis.tm4Port?.netConfirmedTick > 30, null, {
    timeout: 90000,
  });
  await frames[0].waitForFunction(() => Module._WebNetSlotMask() === 15, null, {
    timeout: 15000,
  });
  await lateFrame.waitForFunction(
    () => Module._WebNetSlotMask() === 15 && tm4Port.netViewSlot === 3,
    null,
    { timeout: 15000 },
  );
  assert.equal(await lateFrame.evaluate(() => tm4Port.netViewSlot), 3);
  const newId = await identity(lateFrame, 3);
  assert.notEqual(newId, oldId);
  assert.deepEqual(await Promise.all(frames.map((frame, slot) => identity(frame, slot))), initial);
  for (const retiredToken of [oldToken, canceledCredential]) {
    const stale = await lateFrame.evaluate(async (token) => {
      const room = (await (await fetch("/api" + parent.location.pathname)).json()).room;
      const bindings = await import(new URL("network/tm4_network.js", document.baseURI).href);
      const endpoint = new URL(room.match.endpoint, location.href);
      endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const probe = new bindings.NetworkClient(endpoint.href);
      let sent = false;
      try {
        const deadline = performance.now() + 10000;
        while (performance.now() < deadline) {
          const messages = JSON.parse(probe.update());
          if (probe.connected() && !sent) {
            probe.send(
              JSON.stringify({ type: "resume", token, compatibility: tm4Port.compatibility }),
            );
            sent = true;
          }
          const error = messages.find((message) => message.type === "error");
          if (error) return error.message;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("Stale credential probe did not finish");
      } finally {
        probe.free();
      }
    }, retiredToken);
    assert.match(stale, /cannot resume/);
  }
  console.log("Reused slot has a fresh identity; retired credential rejected", newId);
  const before = await lateFrame.evaluate(() => tm4Port.netConfirmedTick);
  await late.locator("#reconnect-match").click();
  await lateFrame.waitForFunction(
    (tick) => tm4Port.netDiagnostics?.recoveredTick > tick && tm4Port.netConfirmedTick > tick + 15,
    before,
    { timeout: 90000 },
  );
  assert.equal(await identity(lateFrame, 3), newId);
  for (const frame of frames)
    assert.equal(await frame.evaluate(() => Module._WebNetSlotMask()), 15);
  if (ffa) {
    const head = await frames[0].evaluate(() => tm4Port.netMatch.tick);
    const death = 120 + Math.ceil((head - 120 + 12) / 180) * 180;
    await frames[0].waitForFunction((death) => tm4Port.netMatch.tick >= death - 8, death, {
      timeout: 15000,
      polling: 5,
    });
    const oldCar = await frames[0].evaluate(() => Module._WebTestCarHandle(0));
    assert(oldCar);
    await frames[0].evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await frames[1].waitForFunction((death) => tm4Port.netConfirmedTick > death + 100, death, {
      timeout: 15000,
    });
    await frames[0].evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await frames[0].waitForFunction(
      (death) =>
        tm4Port.netDiagnostics?.recoveredTick > death + 90 &&
        tm4Port.netConfirmedTick > death + 100,
      death,
      { timeout: 45000 },
    );
    assert.equal(await identity(frames[0], 0), initial[0]);
    assert((await frames[0].evaluate(() => Module._WebTestCarHandle(0))) > oldCar);
    const results = await frames[0].evaluate(() => tm4Port.netMatch.scores[0]);
    assert.equal(results.deaths, Math.floor((death - 120) / 180) + 1);
    const models = await frames[1].evaluate(() => [
      ...new Set(Object.values(globalThis.ffaTrace.rows).map((row) => row.model)),
    ]);
    assert(
      models.some((model) => model > 1),
      "random respawn uses models outside the all-Orbital initial roster",
    );
    console.log(
      "PASS same-identity portable recovery after disconnected death and respawn",
      death,
      JSON.stringify(results),
    );
  }
  const response = await host.evaluate(async () => {
    const room = (await (await fetch("/api" + location.pathname)).json()).room;
    const response = await fetch(
      "/api" + location.pathname + "/match/" + room.match.id + "/journal",
    );
    if (!response.ok) throw new Error(await response.text());
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  });
  const recorded = Buffer.from(response);
  const headerLength = recorded.readUInt32LE(8);
  const header = JSON.parse(recorded.subarray(12, 12 + headerLength).toString());
  const committed = [];
  for (
    let offset = 16 + headerLength;
    offset < recorded.length && recorded[offset] === 1;
    offset += 135 + 7 * header.start.capacity
  ) {
    const row = offset + 1;
    for (let entry = 0; entry < recorded[row + 29]; entry++)
      committed.push(
        recorded
          .readBigUInt64LE(row + 32 + entry * 11)
          .toString(16)
          .padStart(16, "0"),
      );
  }
  assert.deepEqual(
    committed,
    [oldId, oldId, newId],
    "canceled prediction must never become a committed journal event",
  );
  const journal = resolve(
    ffa ? "build/room-tests/ffa.tm4j" : "build/room-tests/live-membership.tm4j",
  );
  await Bun.write(journal, Uint8Array.from(response));
  assert.deepEqual(errors, []);
  console.log(
    "PASS live room membership: join, explicit departure, sparse reuse, stale credential and same-identity recovery; journal",
    journal,
  );
} finally {
  if (browser) await browser.close();
  await mf?.dispose();
  await native.close();
  if (native.log) console.log(native.log.slice(-20000));
}
