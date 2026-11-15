/* One real browser client and one C-owned original-AI participant. */
/* global Module, tm4Port */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";

import { launchBrowser } from "./helpers/browser.mjs";
import { closeSettings, setPanelOpen } from "./helpers/player.mjs";
import { leaveMatch, readyInLobby } from "./network_lobby.mjs";

const site = new URL(process.env.TM4_WEB_URL ?? "http://127.0.0.1:18183/");
assert(process.env.TM4_MATCH_ENDPOINT, "Start a fresh one-human authority with --bot first");
const browser = await launchBrowser({
  args: [
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});
const errors = [];
try {
  if (process.env.TM4_BOT_REFERENCE) {
    const reference = JSON.parse(await readFile(process.env.TM4_BOT_REFERENCE, "utf8"));
    const oracle = await browser.newPage();
    oracle.on("pageerror", (error) => errors.push(error.message));
    await oracle.goto(new URL("?simulation-reference=1&checkpoint=1", site).href);
    await oracle.waitForFunction(
      () => globalThis.tm4Port?.compatibility && globalThis.tm4Port?.platformReady,
      null,
      { timeout: 90000 },
    );
    const result = await oracle.evaluate((reference) => {
      const check = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      check(
        Module.ccall(
          "WebNetStartFfa",
          "number",
          [
            "number",
            "number",
            "number",
            "number",
            "number",
            "number",
            "string",
            "string",
            "number",
            "string",
            "number",
            "number",
            "number",
          ],
          [
            8,
            3,
            0,
            12345,
            -1,
            1,
            "Orbital\nPizza Boy",
            "0000000000000001\n0000000000000002",
            12,
            "Orbital\nPizza Boy",
            27000,
            100,
            2,
          ],
        ),
        "browser oracle start",
      );
      tm4Port.portableCheckpoint = Uint8Array.from(atob(reference.snapshot), (byte) =>
        byte.charCodeAt(0),
      );
      check(
        Module._WebNetBeginPortableReplay(),
        "Node snapshot into browser: " + tm4Port.portableCheckpointError,
      );
      const canonical = () => {
        check(Module._WebNetCaptureState(), "browser canonical capture");
        return btoa(String.fromCharCode(...tm4Port.netCapturedState));
      };
      check(canonical() === reference.before, "Node/browser portable initial state");
      for (let tick = 0; tick < reference.rows.length; ++tick) {
        if ([80, 190, 330, 540, 650].includes(tick))
          check(Module._WebTestPlacePlayerTarget(1, 0, 1200, 0), "combat placement");
        if (tick === 120) check(Module._WebTestAiRecovery(1), "original recovery predicate");
        if (tick === 230 || tick === 480)
          check(Module._WebTestKillParticipant(tick === 230 ? 0 : 1), "death fixture");
        for (const slot of [0, 1])
          check(
            Module._WebNetSetInput(
              30 + tick,
              slot,
              slot === 0 && tick % 120 < 60 ? 0x4000 : 0,
              0x80808080,
              0,
            ),
            "browser input",
          );
        check(Module._WebNetQueueTick(30 + tick), "browser step");
        check(
          canonical() === reference.rows[tick],
          "Node/browser AI canonical tick " + (31 + tick),
        );
      }
      return reference.rows.length;
    }, reference);
    console.log("Exact Node/browser AI comparisons:", result);
    await oracle.close();
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.route("**/network/tm4_network.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
      const botUpdate = NetworkClient.prototype.update;
      NetworkClient.prototype.update = function() {
        globalThis.botTestClient = this;
        const raw = botUpdate.call(this);
        for (const message of JSON.parse(raw)) if (message.type === 'prediction_prepare' || message.type === 'resume_prepare') globalThis.botTestSetup = message;
        return raw;
      };
    `,
    });
  });
  const match = new URL(site);
  match.searchParams.set("match", process.env.TM4_MATCH_ENDPOINT);
  await page.goto(match.href);
  await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
  await setPanelOpen(page, "render-settings", true);
  await page.locator("#render-scale").selectOption("1");
  await closeSettings(page);
  await readyInLobby(page);
  await page.waitForFunction(
    () =>
      globalThis.tm4Port?.netConfirmedTick > 120 ||
      document.getElementById("status").dataset.matchState === "error",
    null,
    { timeout: 90000 },
  );
  assert.notEqual(
    await page.locator("#status").getAttribute("data-match-state"),
    "error",
    await page.locator("#status").innerText(),
  );
  await closeSettings(page);
  const before = await page.evaluate(() => ({
    setup: globalThis.botTestSetup,
    diagnostics: JSON.parse(globalThis.botTestClient.diagnostics()),
    ai: Module._WebTestAiState(1, 0),
    identity: [
      Module._WebNetParticipantIdentityPart(1, 0),
      Module._WebNetParticipantIdentityPart(1, 1),
    ],
    confirmed: tm4Port.netConfirmedTick,
  }));
  assert.deepEqual(before.setup.bots, [1]);
  assert.equal(before.ai, 2);
  assert.deepEqual(
    before.diagnostics.nativeRoster.map((row) => row.identity.slot),
    [0],
    "bot has no fake native controller",
  );
  await page.evaluate(() => {
    globalThis.botTestClient.condition(90, 10);
    const send = WebSocket.prototype.send;
    globalThis.botRestoreSend = () => {
      WebSocket.prototype.send = send;
    };
    WebSocket.prototype.send = function (data) {
      const socket = this;
      const payload =
        data instanceof ArrayBuffer
          ? data.slice(0)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
            : data;
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) send.call(socket, payload);
      }, 250);
    };
  });
  await page.locator("canvas").focus();
  await page.keyboard.down("x");
  for (let i = 0; i < 12; ++i) {
    await page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight", { delay: 100 });
  }
  await page.keyboard.up("x");
  await page.waitForFunction((tick) => tm4Port.netConfirmedTick > tick + 150, before.confirmed, {
    timeout: 30000,
  });
  await page.evaluate(() => globalThis.botRestoreSend());
  const delayed = await page.evaluate(() => ({
    tick: tm4Port.netConfirmedTick,
    diagnostics: JSON.parse(globalThis.botTestClient.diagnostics()),
    cost: tm4Port.netPredictionCost,
  }));
  assert.ok(
    delayed.diagnostics.prediction.rollbacks > 0,
    "late accepted human input triggered original-AI rollback",
  );
  await mkdir("build/checks", { recursive: true });
  await page.screenshot({ path: "build/checks/ffa-bot-playable.png" });
  await page.reload();
  await page.waitForFunction(
    (tick) =>
      globalThis.tm4Port?.netConfirmedTick > tick ||
      document.getElementById("status").dataset.matchState === "error",
    delayed.tick,
    { timeout: 90000 },
  );
  assert.notEqual(
    await page.locator("#status").getAttribute("data-match-state"),
    "error",
    await page.locator("#status").innerText(),
  );
  const recovered = await page.evaluate(() => ({
    identity: [
      Module._WebNetParticipantIdentityPart(1, 0),
      Module._WebNetParticipantIdentityPart(1, 1),
    ],
    diagnostics: JSON.parse(globalThis.botTestClient.diagnostics()),
    checkpoint: tm4Port.netDiagnostics?.snapshotBytes,
    tick: tm4Port.netConfirmedTick,
  }));
  assert.deepEqual(recovered.identity, before.identity, "bot identity survives human reconnect");
  assert.deepEqual(
    recovered.diagnostics.nativeRoster.map((row) => row.identity.slot),
    [0],
  );
  await leaveMatch(page);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(JSON.stringify({ before, delayed, recovered }, null, 2));
} finally {
  await browser.close();
}
