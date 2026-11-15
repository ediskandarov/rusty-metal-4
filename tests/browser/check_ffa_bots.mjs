/* Two real browser clients and three explicitly configured original-AI participants. */
/* global Module, tm4Port */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";

import { launchBrowser } from "./helpers/browser.mjs";
import { closeSettings, setPanelOpen } from "./helpers/player.mjs";
import { leaveMatch, readyInLobby } from "./network_lobby.mjs";

const site = new URL(process.env.TM4_WEB_URL ?? "http://127.0.0.1:18183/");
assert(
  process.env.TM4_MATCH_ENDPOINT,
  "Start a fresh two-human authority with three --bot arguments first",
);
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
  for (const [name, multiple] of [
    ["TM4_BOT_REFERENCE", false],
    ["TM4_MULTI_BOT_REFERENCE", true],
  ]) {
    if (!process.env[name]) continue;
    const reference = JSON.parse(await readFile(process.env[name], "utf8"));
    const oracle = await browser.newPage();
    oracle.on("pageerror", (error) => errors.push(error.message));
    await oracle.goto(new URL("?simulation-reference=1&checkpoint=1", site).href);
    await oracle.waitForFunction(
      () => globalThis.tm4Port?.compatibility && globalThis.tm4Port?.platformReady,
      null,
      { timeout: 90000 },
    );
    const result = await oracle.evaluate(
      ({ reference, multiple }) => {
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
              multiple ? 171 : 3,
              0,
              12345,
              -1,
              1,
              multiple ? "Orbital\nPizza Boy\nOrbital\nPizza Boy\nOrbital" : "Orbital\nPizza Boy",
              multiple
                ? "0000000000000001\n0000000000000002\n0000000000000004\n0000000000000006\n0000000000000008"
                : "0000000000000001\n0000000000000002",
              12,
              "Orbital\nPizza Boy",
              27000,
              100,
              multiple ? 168 : 2,
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
          if (multiple) {
            const alive = (slot) => !!Module._WebTestCarHandle(slot);
            if ([80, 240, 500].includes(tick)) {
              const source = tick < 400 ? 0 : 1;
              if (alive(source))
                for (const slot of [3, 5, 7])
                  if (alive(slot))
                    check(
                      Module._WebTestPlacePlayerTarget(source, slot, 900 + slot * 150, 0),
                      "multi-bot placement",
                    );
            }
            if (tick === 120 && alive(3)) check(Module._WebTestAiRecovery(3), "multi-bot recovery");
            if (tick === 200 && alive(3) && alive(5)) {
              check(Module._WebTestPreparePlayerDuel(3, 5, 1200), "inter-bot duel");
              const projectile = Module._WebTestCreateParticipantProjectile(3);
              check(
                projectile && Module._WebTestHitParticipant(projectile, 5),
                "inter-bot projectile",
              );
            }
            if (tick === 300 && alive(0)) check(Module._WebTestKillParticipant(0), "human death");
            if (tick === 400)
              check(Module._WebNetDepartParticipant(430, 0, 1, 0), "human departure");
            if (tick === 450 && alive(3)) check(Module._WebTestKillParticipant(3), "bot death");
          } else {
            if ([80, 190, 330, 540, 650].includes(tick))
              check(Module._WebTestPlacePlayerTarget(1, 0, 1200, 0), "combat placement");
            if (tick === 120) check(Module._WebTestAiRecovery(1), "original recovery predicate");
            if (tick === 230 || tick === 480)
              check(Module._WebTestKillParticipant(tick === 230 ? 0 : 1), "death fixture");
          }
          for (const slot of multiple ? [0, 1, 3, 5, 7] : [0, 1])
            if (Module._WebNetSlotMask() & (1 << slot))
              check(
                Module._WebNetSetInput(
                  30 + tick,
                  slot,
                  !multiple && slot === 0 && tick % 120 < 60 ? 0x4000 : 0,
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
      },
      { reference, multiple },
    );
    console.log("Exact Node/browser AI comparisons:", name, result);
    await oracle.close();
  }
  const pages = await Promise.all(
    [0, 1].map(() => browser.newPage({ viewport: { width: 1280, height: 800 } })),
  );
  const match = new URL(site);
  match.searchParams.set("match", process.env.TM4_MATCH_ENDPOINT);
  for (const page of pages) {
    page.on("pageerror", (error) => errors.push(error.message));
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
  }
  await Promise.all(
    pages.map(async (page) => {
      await page.goto(match.href);
      await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
      await setPanelOpen(page, "render-settings", true);
      await page.locator("#render-scale").selectOption("1");
      await closeSettings(page);
      await readyInLobby(page);
    }),
  );
  const healthy = async (page, tick) => {
    await page.waitForFunction(
      (tick) =>
        globalThis.tm4Port?.netConfirmedTick > tick ||
        document.getElementById("status").dataset.matchState === "error",
      tick,
      { timeout: 90000 },
    );
    assert.notEqual(
      await page.locator("#status").getAttribute("data-match-state"),
      "error",
      await page.locator("#status").innerText(),
    );
  };
  await Promise.all(pages.map((page) => healthy(page, 120)));
  const inspect = (page) =>
    page.evaluate(() => ({
      setup: globalThis.botTestSetup,
      diagnostics: JSON.parse(globalThis.botTestClient.diagnostics()),
      controls: [2, 3, 4].map((slot) => Module._WebTestAiState(slot, 0)),
      identities: [0, 1, 2, 3, 4].map((slot) => [
        Module._WebNetParticipantIdentityPart(slot, 0),
        Module._WebNetParticipantIdentityPart(slot, 1),
      ]),
      scores: tm4Port.netMatch?.scores,
      mask: Module._WebNetSlotMask(),
      confirmed: tm4Port.netConfirmedTick,
      cost: tm4Port.netPredictionCost,
      checkpoint: tm4Port.netDiagnostics?.snapshotBytes,
    }));
  const before = await Promise.all(pages.map(inspect));
  for (const state of before) {
    assert.deepEqual(state.setup.bots, [2, 3, 4]);
    assert.deepEqual(state.controls, [2, 2, 2]);
    assert.deepEqual(
      state.diagnostics.nativeRoster.map((row) => row.identity.slot).sort(),
      [0, 1],
      "only actual humans own native controllers",
    );
  }
  assert.deepEqual(before[0].identities, before[1].identities);
  const [page, other] = pages;
  const departingSlot = before[0].diagnostics.nativeRoster.find((row) => row.local).identity.slot;
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
  for (let i = 0; i < 12; ++i)
    await page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight", { delay: 100 });
  await page.keyboard.up("x");
  await healthy(page, before[0].confirmed + 150);
  await page.evaluate(() => globalThis.botRestoreSend());
  const delayed = await inspect(page);
  assert.ok(
    delayed.diagnostics.prediction.rollbacks > 0,
    "late accepted human inputs roll back all original AI",
  );
  await mkdir("build/checks", { recursive: true });
  await page.screenshot({ path: "build/checks/ffa-multiple-bots-playable.png" });
  const continuingTick = (await inspect(other)).confirmed;
  await page.goto("about:blank");
  await healthy(other, continuingTick + 90);
  const duringDisconnect = await inspect(other);
  assert.equal(duringDisconnect.mask, 31, "temporary human disconnect retains all participants");
  assert.deepEqual(duringDisconnect.identities, before[0].identities);
  await page.goto(match.href);
  await healthy(page, duringDisconnect.confirmed);
  const recovered = await inspect(page);
  assert.deepEqual(
    recovered.identities,
    before[0].identities,
    "all participant identities survive reconnect",
  );
  assert.deepEqual(recovered.controls, [2, 2, 2]);
  assert.deepEqual(
    recovered.diagnostics.nativeRoster.map((row) => row.identity.slot).sort(),
    [0, 1],
  );
  await leaveMatch(page);
  await other.waitForFunction(
    (mask) => Module._WebNetSlotMask() === mask,
    31 & ~(1 << departingSlot),
    { timeout: 30000 },
  );
  await healthy(other, recovered.confirmed + 60);
  const remaining = await inspect(other);
  assert.deepEqual(
    remaining.identities.filter((_, slot) => slot !== departingSlot),
    before[0].identities.filter((_, slot) => slot !== departingSlot),
    "first human departure retains the second human and bots",
  );
  assert.deepEqual(remaining.controls, [2, 2, 2]);
  await leaveMatch(other);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(JSON.stringify({ before, delayed, duringDisconnect, recovered, remaining }, null, 2));
} finally {
  await browser.close();
}
