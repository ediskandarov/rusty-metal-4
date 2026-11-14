/* Real room + Lightyear + C/Wasm timeout, using explicit fixture configuration. */
/* global tm4Port, Module */
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { nativeBridge } from "../rooms/native.ts";
import { eventually, runtime } from "../rooms/runtime.ts";
import { launchBrowser } from "./helpers/browser.mjs";
import { setPanelOpen } from "./helpers/player.mjs";

if (!process.env.TM4_DISC_DIR) throw new Error("Set TM4_DISC_DIR to your local disc folder");
const limits = { timeLimitTicks: 600, fragLimit: 20 };
const native = await nativeBridge(
  resolve("build/diagnostic/server"),
  resolve("build/network-native/debug/tm4-deathmatch-server"),
  undefined,
  limits,
);
let mf, browser;
let frames = [];
const ends = [
  { predicted: null, confirmed: null },
  { predicted: null, confirmed: null },
];
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
    [0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 1000 } })),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of pages) page.on("pageerror", (error) => errors.push(error.message));
  const [host, guest] = pages;
  await host.goto(origin);
  await host.locator("#create-player").fill("Host");
  await host.locator("#create-name").fill("Short FFA completion");
  await host.locator("#create-form button").click();
  await host.waitForURL(/\/rooms\/[a-f0-9]{32}$/);
  const roomUrl = host.url();
  await guest.goto(roomUrl);
  await guest.locator("#join-player").fill("Guest");
  await guest.locator("#join-form button").click();
  frames = [];
  for (const [index, page] of pages.entries()) {
    await page.exposeFunction("recordFfaEnd", (kind, value) => {
      ends[index][kind] = value;
    });
    await page.locator("#match-panel").waitFor({ state: "visible" });
    const frame = await (await page.locator("#room-player").elementHandle()).contentFrame();
    await frame.waitForFunction(() => !document.getElementById("disc-folder").disabled, null, {
      timeout: 60000,
    });
    await frame.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
    await frame.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 60000 });
    await page.locator("#room-car").selectOption("Orbital");
    await page.locator("#room-player").scrollIntoViewIfNeeded();
    await setPanelOpen(frame, "render-settings", true);
    await frame.locator("#render-scale").selectOption("1");
    await setPanelOpen(frame, "render-settings", false);
    await frame.evaluate(() => {
      // Observe both predicted and authoritative completion before normal UI teardown.
      globalThis.ffaEnds = { predicted: null, confirmed: null };
      new MutationObserver(() => {
        const next = tm4Port.netMatchServerState;
        if (next?.completion?.reasons && !globalThis.ffaEnds.confirmed) {
          globalThis.ffaEnds.confirmed = structuredClone(next);
          void globalThis.recordFfaEnd("confirmed", globalThis.ffaEnds.confirmed);
        }
      }).observe(document.getElementById("status"), {
        childList: true,
        characterData: true,
        subtree: true,
      });
      const tick = Module._WebNetQueueTick;
      Module._WebNetQueueTick = (value) => {
        const result = tick(value);
        if (tm4Port.netMatch?.completion?.reasons) {
          globalThis.ffaEnds.predicted = structuredClone(tm4Port.netMatch.completion);
          void globalThis.recordFfaEnd("predicted", globalThis.ffaEnds.predicted);
        }
        return result;
      };
    });
    frames.push(frame);
  }
  await host.locator("#prepare-match").click();
  await host.waitForFunction(() => !document.getElementById("room-ready").disabled, null, {
    timeout: 120000,
  });
  for (const page of pages) await page.locator("#room-ready").click();
  await host.waitForFunction(() => !document.getElementById("start-match").disabled);
  const id = await host.evaluate(
    async () => (await (await fetch("/api" + location.pathname)).json()).room.match.id,
  );
  await host.locator("#start-match").click();
  for (const frame of frames)
    await frame.waitForFunction(() => tm4Port.netConfirmedTick >= 30, null, { timeout: 90000 });
  if (process.env.TM4_TEST_END_RECOVERY === "1") {
    await frames[1].waitForFunction(() => tm4Port.netConfirmedTick >= 590, null, {
      timeout: 45000,
    });
    await guest.locator("#reconnect-match").click();
  }
  await eventually(
    async () => ends,
    (values) => values.every((value) => value.confirmed),
    45000,
  );
  for (const [index, observed] of ends.entries()) {
    const expected = { tick: limits.timeLimitTicks, reasons: 1, winners: 3 };
    if (process.env.TM4_TEST_END_RECOVERY !== "1" || index === 0)
      assert.deepEqual(observed.predicted, expected);
    assert.deepEqual(observed.confirmed.completion, expected);
    assert.equal(observed.confirmed.nextMode, 0);
    assert.equal(observed.confirmed.acceptsContinue, false);
  }
  await eventually(
    async () => native.stops,
    (stops) => stops === 1,
    45000,
  );
  assert(
    native.history.some((entry) => entry.phase === "results"),
    "authority reports normal results",
  );
  assert(!native.history.some((entry) => ["failed", "closed"].includes(entry.phase)));
  const room = await host.evaluate(
    async () => (await (await fetch("/api" + location.pathname)).json()).room,
  );
  assert.equal(room.match, null);
  assert.equal(room.participantCount, 2);
  assert(room.participants.every((participant) => !participant.ready));
  assert.match(room.notice, /Match finished/);
  const bytes = await host.evaluate(async (id) => {
    const response = await fetch("/api" + location.pathname + "/match/" + id + "/journal");
    if (!response.ok) throw new Error(await response.text());
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }, id);
  await Bun.write("build/room-tests/ffa-completion.tm4j", Uint8Array.from(bytes));
  assert.deepEqual(errors, []);
  console.log(
    "PASS confirmed tied timeout at tick 600, normal room results, released server, cleared readiness and retained journal",
  );
} catch (error) {
  console.error("Observed endings", JSON.stringify(ends));
  console.error(
    "Browser states",
    await Promise.all(
      frames.map((frame) =>
        frame
          .evaluate(() => ({
            ends: globalThis.ffaEnds,
            local: globalThis.tm4Port?.netMatch,
            server: globalThis.tm4Port?.netMatchServerState,
            diagnostics: globalThis.tm4Port?.netDiagnostics,
            status: document.getElementById("status")?.textContent,
          }))
          .catch((error) => String(error)),
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
