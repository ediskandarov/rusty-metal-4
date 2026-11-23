/* global tm4Port, tm4LivePrediction */
import assert from "node:assert/strict";
import { once } from "node:events";

import { WebSocket, WebSocketServer } from "ws";

import { launchBrowser } from "./helpers/browser.mjs";
import { closeSettings, setPanelOpen } from "./helpers/player.mjs";
import { readyInLobby } from "./network_lobby.mjs";

const endpoint = process.env.TM4_MATCH_ENDPOINT;
const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:8120/";
const delay = Number(process.env.TM4_INPUT_DELAY_MS ?? 125);
const stall = Number(process.env.TM4_INPUT_STALL_MS ?? 200);
const stallPeriodMs = 5000;
const stallStartsMs = 20000;
const stallEndsMs = 60000;
const metrics = [];
const pages = [];
const runtimeErrors = [];
let reconnecting = false;
let expectedConnectionLosses = 0;
const stalledBatches = new Set();
let testStarted;
let missingGasTicks = 0;
let longestMissingGasTicks = 0;
let observedGas = false;
assert(endpoint, "Set TM4_MATCH_ENDPOINT to a fresh two-human match server");
assert(Number.isFinite(delay) && delay >= 0 && delay <= 2000);
assert(Number.isFinite(stall) && stall >= 0 && stall <= 2000);

// Delay both directions before Lightyear decoding. Preserve WebSocket message order.
const proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
const timers = new Set();
const upstreams = new Set();
function later(action) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    action();
  }, delay);
  timers.add(timer);
}
function send(socket, data) {
  if (socket.readyState === WebSocket.OPEN) socket.send(data);
}
proxy.on("connection", (downstream) => {
  const upstream = new WebSocket(endpoint);
  upstreams.add(upstream);
  const pending = [];
  upstream.on("open", () => {
    for (const data of pending) later(() => send(upstream, data));
    pending.length = 0;
    if (downstream.readyState !== WebSocket.OPEN) upstream.close();
  });
  downstream.on("message", (data) => {
    if (upstream.readyState === WebSocket.CONNECTING) pending.push(data);
    else later(() => send(upstream, data));
  });
  let lastDelivery = 0;
  upstream.on("message", (data) => {
    const now = performance.now();
    const elapsed = testStarted === undefined ? 0 : now - testStarted;
    const phase = (elapsed - stallStartsMs) % stallPeriodMs;
    const extra =
      elapsed >= stallStartsMs && elapsed < stallEndsMs && phase < stall ? stall - phase : 0;
    // Release a delayed batch in wire order. Later packets cannot overtake its first packet.
    const due = Math.max(lastDelivery, now + delay + extra);
    lastDelivery = due;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (extra > 0 && downstream.readyState === WebSocket.OPEN)
        stalledBatches.add(Math.floor((elapsed - stallStartsMs) / stallPeriodMs));
      send(downstream, data);
    }, due - now);
    timers.add(timer);
  });
  downstream.on("close", () => upstream.close());
  upstream.on("close", () => {
    upstreams.delete(upstream);
    downstream.close();
  });
  upstream.on("error", () => downstream.close());
  downstream.on("error", () => upstream.close());
});
let browser;
try {
  await once(proxy, "listening");
  browser = await launchBrowser({ args: ["--mute-audio"] });
  for (let index = 0; index < 2; index++) {
    const page = await browser.newPage();
    pages.push(page);
    page.on("pageerror", (error) => {
      runtimeErrors.push({ client: index, type: "pageerror", message: error.message });
      console.error("Client", index, error);
    });
    page.on("console", (message) => {
      if (message.type() !== "error" || /^\[[ID]\]/.test(message.text())) return;
      if (
        reconnecting &&
        index === 1 &&
        /^Lightyear runtime failure [^:\n]+: Lost the Lightyear connection(?:\n|$)/.test(
          message.text(),
        )
      ) {
        expectedConnectionLosses++;
        return;
      }
      runtimeErrors.push({ client: index, type: "console", message: message.text() });
      console.error("Client", index, message.text());
    });
    const url = new URL(site);
    url.searchParams.set(
      "match",
      index === 0 ? endpoint : `ws://127.0.0.1:${proxy.address().port}`,
    );
    await page.goto(url.href);
    if (process.env.TM4_DISC_DIR)
      await page.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
    await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
      timeout: 90000,
    });
    await setPanelOpen(page, "render-settings", true);
    await page.locator("#render-scale").selectOption("1");
    await closeSettings(page);
    await readyInLobby(page);
  }
  for (const page of pages) {
    await page.waitForFunction(
      () => {
        const status = document.querySelector("#status")?.textContent ?? "";
        if (document.querySelector("#status")?.dataset.matchState === "error")
          throw new Error(status);
        return globalThis.tm4Port?.netConfirmedTick > 20;
      },
      null,
      {
        timeout: 60000,
      },
    );
  }

  // Remote transitions force corrections; an idle peer would not exercise rollback.
  await pages[0].evaluate(() => {
    let down = false;
    setInterval(() => {
      down = !down;
      document.querySelector("canvas").dispatchEvent(
        new KeyboardEvent(down ? "keydown" : "keyup", {
          key: "x",
          code: "KeyX",
          bubbles: true,
        }),
      );
    }, 50);
  });
  const delayed = pages[1];
  await delayed.evaluate(async () => {
    const frames = (globalThis.inputLatencyFrames = []);
    globalThis.inputResponse = {};
    const { NetworkClient } = await import(
      new URL("network/tm4_network.js", document.baseURI).href
    );
    const sample = NetworkClient.prototype.prediction_input;
    NetworkClient.prototype.prediction_input = function (buttons, axes, analog) {
      const response = globalThis.inputResponse;
      if (buttons & 64 && response.started !== undefined && response.sampleMs === undefined)
        response.sampleMs = performance.now() - response.started;
      return sample.call(this, buttons, axes, analog);
    };
    document.addEventListener("keydown", (event) => {
      if (event.code === "KeyX" && globalThis.inputResponse.started === undefined)
        globalThis.inputResponse.started = performance.now();
    });
    const stage = tm4LivePrediction.stage_live_input;
    tm4LivePrediction.stage_live_input = (tick, slot, buttons, axes, analog) => {
      const response = globalThis.inputResponse;
      if (
        slot === 1 &&
        buttons & 64 &&
        response.started !== undefined &&
        response.localMs === undefined
      )
        response.localMs = performance.now() - response.started;
      return stage(tick, slot, buttons, axes, analog);
    };
    const record = tm4LivePrediction.journal_authority_frame;
    tm4LivePrediction.journal_authority_frame = (json) => {
      const { frame } = JSON.parse(json);
      frames.push({ tick: frame.tick, buttons: frame.inputs[1].buttons });
      const response = globalThis.inputResponse;
      if (
        frame.inputs[1].buttons & 64 &&
        response.started !== undefined &&
        response.authorityMs === undefined
      )
        response.authorityMs = performance.now() - response.started;
      record(json);
    };
  });
  await delayed.locator("canvas").click();
  await delayed.keyboard.down("x");
  await delayed.keyboard.down("w");
  const started = Date.now();
  testStarted = performance.now();
  let last;
  let previousTick;
  for (let sample = 0; sample < 7; sample++) {
    await delayed.waitForTimeout(10000);
    last = await delayed.evaluate(() => ({
      frames: globalThis.inputLatencyFrames.splice(0),
      status: document.querySelector("#status").textContent,
      transport: tm4Port.netDiagnostics?.transport,
      cost: { ...tm4Port.netPredictionCost },
      inputResponse: globalThis.inputResponse,
    }));
    const gas = last.frames.filter(({ buttons }) => buttons & 64).length;
    for (const { buttons } of last.frames) {
      if (buttons & 64) {
        observedGas = true;
        missingGasTicks = 0;
      } else if (observedGas) {
        longestMissingGasTicks = Math.max(longestMissingGasTicks, ++missingGasTicks);
      }
    }
    metrics.push({
      ...last.transport,
      cost: last.cost,
      inputResponse: last.inputResponse,
      elapsedSeconds: (Date.now() - started) / 1000,
      configuredDelayMs: delay,
      configuredStallMs: stall,
      injectedStallBatches: stalledBatches.size,
      authorityFrames: last.frames.length,
      gasFrames: gas,
      longestMissingGasTicks,
    });
    assert.match(last.status, /Live prediction/);
    assert(last.transport, "Transport diagnostics must remain available");
    assert.equal(last.transport.clock.inputDelayTicks, 0, "No artificial local input delay");
    assert(last.inputResponse.localMs < 100, "Local gas responds within 100 ms");
    if (delay >= 100)
      assert(
        last.inputResponse.localMs < last.inputResponse.authorityMs,
        "Local gas precedes authority",
      );
    assert(last.frames.length >= 250, "Authority should sustain approximately 30 TPS");
    for (const frame of last.frames) {
      if (previousTick !== undefined) assert.equal(frame.tick, previousTick + 1);
      previousTick = frame.tick;
    }
    assert(gas / last.frames.length > 0.9, "Held gas must reach authority throughout the run");
    assert(
      longestMissingGasTicks <= 9,
      "Held gas must not disappear for more than 300 ms after first reaching authority",
    );
    console.log("PASS held gas", Math.round((Date.now() - started) / 1000), "s", {
      rttMs: last.transport.rttMs,
      confirmed: last.transport.prediction.confirmed,
      rollbacks: last.transport.prediction.rollbacks,
      gas,
      frames: last.frames.length,
      longestMissingGasTicks,
    });
  }
  assert(last.transport.prediction.rollbacks > 100, "Exercise sustained corrections");
  if (delay > 0) assert(last.transport.rttMs >= delay * 1.8, "Measure the injected round trip");
  if (stall > 0)
    assert.equal(
      stalledBatches.size,
      (stallEndsMs - stallStartsMs) / stallPeriodMs,
      "Deliver every scheduled delayed packet batch",
    );
  await delayed.keyboard.up("w");
  await delayed.keyboard.up("x");
  await delayed.waitForTimeout(2000);
  const released = await delayed.evaluate(() => globalThis.inputLatencyFrames.slice(-20));
  assert.equal(released.length, 20);
  assert(
    released.every(({ buttons }) => !(buttons & 64)),
    "Release must also reach authority",
  );
  assert.deepEqual(runtimeErrors, [], "Clients must not report runtime errors");
  const beforeReconnect = await delayed.evaluate(() => tm4Port.netConfirmedTick);
  reconnecting = true;
  for (const socket of proxy.clients) socket.terminate();
  await delayed.waitForFunction(
    (before) =>
      document.querySelector("#status")?.textContent.includes("Live prediction") &&
      tm4Port.netConfirmedTick > before + 45,
    beforeReconnect,
    { timeout: 45000 },
  );
  reconnecting = false;
  assert.equal(expectedConnectionLosses, 1, "Only the forced connection loss is expected");
  await delayed.evaluate(() => {
    const frames = (globalThis.inputLatencyFrames = []);
    const record = tm4LivePrediction.journal_authority_frame;
    tm4LivePrediction.journal_authority_frame = (json) => {
      const { frame } = JSON.parse(json);
      frames.push({ tick: frame.tick, buttons: frame.inputs[1].buttons });
      record(json);
    };
  });
  await delayed.locator("canvas").click();
  await delayed.keyboard.down("x");
  await delayed.waitForTimeout(3000);
  const resumedGas = await delayed.evaluate(() => globalThis.inputLatencyFrames.slice(-30));
  assert.equal(resumedGas.length, 30);
  assert(
    resumedGas.every(({ buttons }) => buttons & 64),
    "Gas must survive snapshot handoff",
  );
  await delayed.keyboard.up("x");
  await delayed.waitForTimeout(2000);
  const resumedRelease = await delayed.evaluate(() => globalThis.inputLatencyFrames.slice(-20));
  assert.equal(resumedRelease.length, 20);
  assert(
    resumedRelease.every(({ buttons }) => !(buttons & 64)),
    "Release after reconnect",
  );
  assert.deepEqual(runtimeErrors, [], "No unexpected runtime errors during reconnect");
  const resumedTransport = await delayed.evaluate(() => tm4Port.netDiagnostics?.transport);
  assert.equal(resumedTransport.clock.inputDelayTicks, 0, "No input delay after snapshot handoff");
  metrics.push({
    ...resumedTransport,
    reconnected: true,
    expectedConnectionLosses,
  });
  console.log("PASS delayed input after snapshot reconnect");
  console.log("PASS sustained high-RTT input, ordered packet stalls, rollback and release", {
    injectedStallBatches: stalledBatches.size,
  });
} catch (error) {
  const clients = await Promise.all(
    pages.map(async (page, client) => {
      try {
        return {
          client,
          ...(await page.evaluate(() => ({
            status: document.querySelector("#status")?.textContent ?? null,
            transport: globalThis.tm4Port?.netDiagnostics?.transport ?? null,
          }))),
        };
      } catch (captureError) {
        return { client, captureError: String(captureError) };
      }
    }),
  );
  metrics.push({
    failure: String(error),
    runtimeErrors,
    clients,
    injectedStallBatches: stalledBatches.size,
  });
  throw error;
} finally {
  // Keep the failing sample too; a timing regression must leave evidence before teardown.
  await Bun.write("build/checks/input-latency.json", JSON.stringify(metrics, null, 2));
  await browser?.close();
  for (const timer of timers) clearTimeout(timer);
  for (const socket of proxy.clients) socket.terminate();
  for (const socket of upstreams) socket.terminate();
  await new Promise((resolve) => proxy.close(resolve));
}
