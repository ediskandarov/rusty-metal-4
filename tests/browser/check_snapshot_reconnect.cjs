/* global tm4Port */
const assert = require("node:assert/strict");
const { readyInLobby } = require("./network_lobby.cjs");
const { chromium } = require("playwright");

const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
const endpoint = process.env.TM4_MATCH_ENDPOINT;
const prelude = Number(process.env.TM4_RESUME_TEST_TICKS ?? 360);
const players = Number(process.env.TM4_MATCH_PLAYERS ?? 2);
const resumeSlot = Number(process.env.TM4_RESUME_SLOT ?? 0);
const width = Number(process.env.TM4_ROSTER_WIDTH ?? 1280);
const height = Number(process.env.TM4_ROSTER_HEIGHT ?? 800);
assert(Number.isInteger(players) && players >= 2 && players <= 8);
assert(Number.isInteger(resumeSlot) && resumeSlot >= 0 && resumeSlot < players);
const combat = process.env.TM4_RESUME_COMBAT === "1";
const allConditioned = process.env.TM4_RESUME_ALL_CONDITIONED === "1";
const retryCycles = Number(process.env.TM4_RESUME_RETRY_CYCLES ?? 1);
assert(Number.isInteger(retryCycles) && retryCycles >= 1 && retryCycles <= 3);
const offerHoldMs = Number(process.env.TM4_RESUME_OFFER_HOLD_MS ?? 0);
assert(Number.isInteger(offerHoldMs) && offerHoldMs >= 0 && offerHoldMs <= 2000);
const holdOffers = Number(process.env.TM4_RESUME_HOLD_OFFERS ?? 1);
assert(Number.isInteger(holdOffers) && holdOffers >= 1 && holdOffers <= 3);
const expectExhaustion = process.env.TM4_RESUME_EXPECT_EXHAUSTION === "1";
assert(!expectExhaustion || (offerHoldMs >= 400 && holdOffers === 3));
const exactWindow = process.env.TM4_RESUME_EXACT_WINDOW === "1";
assert(endpoint && Number.isInteger(prelude) && prelude >= 120);
const credentialKey = "tm4.resume." + endpoint;
const target = new URL(site);
target.searchParams.set("match", endpoint);

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const errors = [];
    const open = async (resume, mode) => {
      const page = await browser.newPage({ viewport: { width, height } });
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.log("PAGE ERROR", mode ?? "normal", error.message);
      });
      page.on("console", (msg) => {
        if (msg.text().startsWith("RECONNECT PHASE")) console.log(msg.text());
        if (
          msg.type() === "error" &&
          /Match clock at disconnect|Lightyear runtime failure|C CHECKPOINT REFUSAL/.test(
            msg.text(),
          )
        ) {
          console.log("DISCONNECT", mode ?? "normal", msg.text());
          void Promise.all(msg.args().map((arg) => arg.jsonValue())).then(
            (details) => console.log("DETAILS", JSON.stringify(details)),
            () => {},
          );
        }
      });
      if (resume) {
        await page.addInitScript(
          ([key, resume]) => sessionStorage.setItem(key, resume),
          [credentialKey, resume],
        );
      }
      await page.route("**/network/tm4_network.js", async (route) => {
        const response = await route.fetch();
        const hook = `
          const savedSend = NetworkClient.prototype.send;
          NetworkClient.prototype.send = function(raw) {
            const request = JSON.parse(raw);
            if (${JSON.stringify(mode)} === "incompatible" && request.type === "resume")
              request.compatibility.build = "0".repeat(64);
            if (request.type === "resume_clock") {
              const clocks = globalThis.testResumeClocks ||= [];
              if (clocks.length < 4) clocks.push({ ...request, native: this.prediction_clock(),
                applied: globalThis.tm4Port.netMatch.tick, time: performance.now() });
            }
            return savedSend.call(this, JSON.stringify(request));
          };
          const savedUpdate = NetworkClient.prototype.update;
          let conditioned = false;
          let observedBridge;
          let handoff;
          let heldOffer;
          let heldUntil;
          let heldOffers = 0;
          const local = new Map();
          NetworkClient.prototype.update = function() {
            const bridge = globalThis.tm4LivePrediction;
            if (bridge && bridge !== observedBridge) {
              observedBridge = bridge;
              local.clear();
              const restore = bridge.restore_live_tick;
              globalThis.testRestoreTicks = [];
              bridge.restore_live_tick = (tick) => {
                if (globalThis.testRestoreTicks.length === 128) globalThis.testRestoreTicks.shift();
                globalThis.testRestoreTicks.push(tick);
                const result = restore(tick);
                if (!result) console.error("C CHECKPOINT REFUSAL", tick, globalThis.tm4Port.localCheckpointError);
                return result;
              };
              const step = bridge.step_live_tick;
              bridge.step_live_tick = (tick) => {
                const result = step(tick);
                if (result) {
                  const { digest, sections } = globalThis.tm4Port.netMatch;
                  local.set(tick + 1, [digest, ...sections]);
                  if (local.size > 120) local.delete(local.keys().next().value);
                }
                return result;
              };
            }
            if ((${JSON.stringify(mode)} || ${JSON.stringify(allConditioned)}) && !conditioned && this.connected()) {
              this.condition(72, 12);
              conditioned = true;
            }
            const messages = JSON.parse(savedUpdate.call(this));
            if (${JSON.stringify(exactWindow && mode === "delay")}) {
              const index = messages.findIndex(({type}) => type === "resume_live");
              if (index >= 0) [handoff] = messages.splice(index, 1);
              if (handoff) {
                const depth = (this.prediction_clock() - handoff.anchor - handoff.head) | 0;
                if (depth >= 12) {
                  globalThis.testReconnectDepth = depth;
                  messages.push(handoff);
                  handoff = undefined;
                }
              }
            }
            if (${JSON.stringify(offerHoldMs)} > 0 && ${JSON.stringify(mode)} === "delay") {
              const index = messages.findIndex(({type}) => type === "resume_live");
              if (heldOffers < ${JSON.stringify(holdOffers)} && index >= 0) {
                [heldOffer] = messages.splice(index, 1);
                heldUntil = performance.now() + ${JSON.stringify(offerHoldMs)};
                heldOffers++;
              }
              if (heldOffer && performance.now() >= heldUntil) {
                messages.push(heldOffer);
                heldOffer = undefined;
              }
            }
            for (const message of messages) {
              if (message.type === "resume_live") {
                const offers = globalThis.testResumeOffers ||= [];
                if (offers.length < 4) offers.push({ head: message.head,
                  native: this.prediction_clock(), applied: globalThis.tm4Port.netMatch.tick,
                  depth: (this.prediction_clock() - message.anchor - message.head) | 0,
                  link: JSON.parse(this.diagnostics()),
                  time: performance.now() });
                globalThis.testHandoffHead = message.head;
                globalThis.testReconnectDepth =
                  (this.prediction_clock() - message.anchor - message.head) | 0;
              }
              if (["resume_prepare", "snapshot_begin", "resume_live", "resume_active", "error"].includes(message.type)) console.log("RECONNECT PHASE", ${JSON.stringify(mode)}, message.type, message.tick ?? message.head ?? message.message ?? "");
              if (message.type === "snapshot_begin") {
                const port = globalThis.tm4Port;
                const game = globalThis.Module;
                port.testMixerStarts = [];
                const endReplay = game._WebNetEndReplay;
                globalThis.testReplayEnds = 0;
                game._WebNetEndReplay = () => {
                  ++globalThis.testReplayEnds;
                  return endReplay();
                };
                const restore = game._WebNetBeginPortableReplay;
                globalThis.testPortableRestores = 0;
                game._WebNetBeginPortableReplay = () => {
                  ++globalThis.testPortableRestores;
                  const result = restore();
                  if (result) {
                    game.ccall("WebTestSnapshotObjects", null, ["string"], ["weaponProjectile"]);
                    globalThis.testRestoredProjectiles = port.testSnapshotObjects.length;
                  }
                  return result;
                };
                globalThis.testPresentationTicks = [];
                const confirm = game._WebNetConfirmPresentationTick;
                game._WebNetConfirmPresentationTick = (tick) => {
                  globalThis.testPresentationTicks.push(tick);
                  return confirm(tick);
                };
              }
              if (message.type === "snapshot_chunk") {
                document.documentElement.dataset.snapshot = String(message.offset + message.data.length);
                if (${JSON.stringify(mode)} === "corrupt" && message.offset === 0) message.data[0] ^= 1;
              }
              if (message.type === "frame") {
                const states = globalThis.testVerifiedStates ||= [];
                if (states.length === 120) states.shift();
                const digests = local.get(message.tick + 1);
                const authority = [message.state.digest, ...message.state.sections];
                if (!digests || digests.some((digest, i) => digest !== authority[i]))
                  throw new Error("Locally sampled simulation disagrees at tick " + (message.tick + 1));
                states.push([message.tick + 1, digests]);
              }
            }
            return JSON.stringify(messages);
          };
        `;
        const headers = response.headers();
        delete headers["content-length"];
        await route.fulfill({
          status: response.status(),
          headers,
          body: (await response.text()) + hook,
        });
      });
      await page.goto(target.href);
      await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 60000 });
      return page;
    };
    const status = (page) => page.locator("#status").textContent();
    const confirmed = (page) => page.evaluate(() => tm4Port.netConfirmedTick ?? 0);
    const waitTick = async (page, tick) => {
      await page.waitForFunction(
        (tick) =>
          (globalThis.tm4Port?.netConfirmedTick ?? 0) >= tick ||
          document.querySelector("#status")?.dataset.matchState === "error",
        tick,
        { timeout: Math.max(20_000, prelude * 40), polling: 75 },
      );
      assert((await confirmed(page)) >= tick, await status(page));
    };
    const initial = [await open()];
    await initial[0].locator("#car-lobby").waitFor({ state: "visible", timeout: 60000 });
    for (let i = 1; i < players; i++) initial.push(await open());
    await Promise.all(initial.map(readyInLobby));
    await Promise.all(initial.map((page) => waitTick(page, 60)));
    if (combat)
      for (const page of initial) {
        await page.keyboard.down("e");
        await page.keyboard.down("w");
      }
    const slots = await Promise.all(
      initial.map((page) => page.evaluate(() => tm4Port.netViewSlot)),
    );
    assert.deepEqual(
      [...slots].sort((a, b) => a - b),
      Array.from({ length: players }, (_, i) => i),
    );
    const first = initial[slots.indexOf(resumeSlot)];
    const survivors = initial.filter((page) => page !== first);
    const survivor = survivors[0];
    assert.equal(await first.evaluate(() => tm4Port.netViewSlot), resumeSlot);
    const credential = await first.evaluate((key) => sessionStorage.getItem(key), credentialKey);
    assert.match(credential, /^[a-f0-9]{64}$/);

    const duplicate = await open(credential);
    await duplicate.locator("#status").filter({ hasText: "cannot resume" }).waitFor();
    await duplicate.close();
    await first.locator("canvas").focus();
    await first.keyboard.down("x");
    await waitTick(first, 100);
    await first.keyboard.up("x");
    await waitTick(first, prelude);
    const dropTick = await confirmed(first);
    await first.close();
    await waitTick(survivor, dropTick + 30);

    const progressStart = await survivor.evaluate(() => ({
      tick: tm4Port.netConfirmedTick,
      time: performance.now(),
    }));
    const incompatible = await open(credential, "incompatible");
    await incompatible.locator("#status").filter({ hasText: "cannot resume" }).waitFor();
    await incompatible.close();

    for (let cycle = 0; cycle < retryCycles; cycle++) {
      const interrupted = await open(credential, "delay");
      await interrupted.locator("html[data-snapshot]").waitFor();
      await interrupted.close();
      await waitTick(survivor, (await confirmed(survivor)) + 20);

      const malformed = await open(credential, "corrupt");
      await malformed
        .locator("#status")
        .filter({ hasText: "Corrupt reconnect snapshot" })
        .waitFor({ timeout: 20_000 });
      await malformed.close();
      await waitTick(survivor, (await confirmed(survivor)) + 20);
    }
    let steering = combat;
    const steer = combat
      ? (async () => {
          let previous;
          let left = false;
          while (steering) {
            if (previous) await survivor.keyboard.up(previous);
            previous = left ? "ArrowLeft" : "ArrowRight";
            left = !left;
            await survivor.keyboard.down(previous);
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          if (previous) await survivor.keyboard.up(previous);
        })()
      : undefined;
    void steer?.catch((error) => errors.push(error.message));
    let exhausted;
    if (expectExhaustion) {
      const late = await open(credential, "delay");
      await late
        .locator('#status[data-match-state="error"]')
        .filter({ hasText: "could not keep up" })
        .waitFor({ timeout: 30000 });
      exhausted = await late.evaluate(() => ({
        retargets: tm4Port.netDiagnostics.resumeRetargets,
        offers: globalThis.testResumeOffers,
        ends: globalThis.testReplayEnds,
      }));
      assert.equal(exhausted.retargets, 2);
      assert.equal(exhausted.offers.length, 3);
      assert.equal(exhausted.ends, 1);
      await late.close();
      await waitTick(survivor, (await confirmed(survivor)) + 60);
    }
    const recovered = await open(credential, expectExhaustion ? "retry" : "delay");
    await recovered
      .waitForFunction(
        () => {
          const status = document.querySelector("#status");
          return (
            status?.textContent.includes("Live prediction") ||
            status?.dataset.matchState === "error"
          );
        },
        null,
        { timeout: 30_000 },
      )
      .catch(async (error) => {
        console.error(
          "RECONNECT TIMEOUT",
          await recovered.evaluate(() => ({
            status: document.querySelector("#status")?.textContent,
            phase: document.querySelector("#status")?.dataset.matchState,
            diagnostics: tm4Port.netDiagnostics,
            match: tm4Port.netMatch,
          })),
        );
        throw error;
      });
    const result = await status(recovered);
    if (!result.includes("Live prediction"))
      console.log(
        "HANDOFF FAILURE",
        await recovered.evaluate(() => ({
          depth: globalThis.testReconnectDepth,
          clocks: globalThis.testResumeClocks,
          offers: globalThis.testResumeOffers,
          diagnostics: tm4Port.netDiagnostics,
        })),
      );
    assert(result.includes("Live prediction"), result);
    const reconnected = await recovered.evaluate(() => ({
      slot: tm4Port.netViewSlot,
      render: tm4Port.renderLimit,
      diagnostics: tm4Port.netDiagnostics,
      confirmed: tm4Port.netConfirmedTick,
      handoffDepth: globalThis.testReconnectDepth,
    }));
    assert(reconnected.diagnostics.snapshotTick >= dropTick, JSON.stringify(reconnected));
    assert(reconnected.diagnostics.recoveredTick >= reconnected.diagnostics.snapshotTick);
    assert(reconnected.diagnostics.recoveredTick - reconnected.diagnostics.snapshotTick < 240);
    assert.equal(reconnected.render, 30);
    assert.equal(reconnected.slot, resumeSlot);
    if (exactWindow) {
      assert.equal(reconnected.handoffDepth, 12);
      assert.equal(reconnected.diagnostics.transport.prediction.maxDepth, 12);
      assert(reconnected.diagnostics.transport.prediction.windowWaits > 0);
    }
    console.log("HANDOFF", JSON.stringify(reconnected));
    await recovered.locator("canvas").focus();
    const pressedAt = await recovered.evaluate(() => performance.now());
    await recovered.keyboard.down("x");
    await recovered.keyboard.down("w");
    await recovered.waitForFunction(
      (slot) =>
        (tm4Port.netViewSlot === slot && tm4Port.cars?.[slot]?.throttle > 0) ||
        document.querySelector("#status")?.dataset.matchState === "error",
      resumeSlot,
      { timeout: 5_000 },
    );
    assert((await status(recovered)).includes("Live prediction"), await status(recovered));
    const responseMs = await recovered.evaluate(
      (pressedAt) => performance.now() - pressedAt,
      pressedAt,
    );
    assert(responseMs < 100, "Resumed local input response: " + responseMs);
    await Promise.all([
      ...survivors.map((page) => waitTick(page, reconnected.confirmed + 45)),
      waitTick(recovered, reconnected.confirmed + 45),
    ]);
    await recovered.keyboard.up("w");
    await recovered.keyboard.up("x");
    steering = false;
    await steer;
    const replay = await recovered.evaluate(() => ({
      restores: globalThis.testRestoreTicks,
      head: globalThis.testHandoffHead,
      depth: globalThis.testReconnectDepth,
      ends: globalThis.testReplayEnds,
      portableRestores: globalThis.testPortableRestores,
      offers: globalThis.testResumeOffers,
      clocks: globalThis.testResumeClocks,
    }));
    assert.equal(replay.ends, 1);
    assert.equal(replay.portableRestores, 1);
    for (const offer of replay.offers) {
      assert.equal(offer.link.prediction.resumePreparing, true);
      assert.notEqual(offer.link.prediction.confirmedNativeTick, null);
      assert(offer.link.prediction.acceptedDepth <= 12);
      assert.equal(offer.link.prediction.historyBytes, 0);
      assert.equal(offer.link.prediction.rollbacks, 0);
    }
    assert((reconnected.diagnostics.resumeRetargets ?? 0) <= 2);
    if (offerHoldMs >= 400 && !expectExhaustion)
      assert((reconnected.diagnostics.resumeRetargets ?? 0) > 0);
    if (combat)
      assert(
        replay.restores.filter((tick) => tick >= replay.head && tick <= replay.head + replay.depth)
          .length >= 2,
        JSON.stringify(replay),
      );
    const presentation = await recovered.evaluate(() => ({
      ticks: globalThis.testPresentationTicks,
      sounds: tm4Port.testMixerStarts,
    }));
    assert(presentation.ticks.length >= 20);
    assert(presentation.ticks.every((tick) => tick > reconnected.diagnostics.recoveredTick));
    assert(presentation.ticks.every((tick, i, ticks) => i === 0 || ticks[i - 1] + 1 === tick));
    assert(presentation.sounds.length > 0, "No mixer starts after reconnect");
    assert(!presentation.sounds.some((entry) => entry[5]), "Mixer started during replay");
    const [sourceFrames, recoveredFrames] = await Promise.all(
      [survivor, recovered].map((page) => page.evaluate(() => globalThis.testVerifiedStates)),
    );
    const source = new Map(sourceFrames);
    const common = recoveredFrames.filter(
      ([tick]) => tick > reconnected.confirmed && source.has(tick),
    );
    assert(common.length >= 20);
    for (const [tick, sections] of common) assert.deepEqual(sections, source.get(tick));
    const progressEnd = await survivor.evaluate(() => ({
      tick: tm4Port.netConfirmedTick,
      time: performance.now(),
    }));
    const receivedAuthorityHz =
      ((progressEnd.tick - progressStart.tick) * 1000) / (progressEnd.time - progressStart.time);
    assert(receivedAuthorityHz >= 28 && receivedAuthorityHz <= 32, receivedAuthorityHz);
    const survivorHistories = await Promise.all(
      survivors.map((page) =>
        page.evaluate(() => ({
          confirmed: tm4Port.netConfirmedTick,
          prediction: tm4Port.netDiagnostics.transport.prediction,
        })),
      ),
    );
    for (const state of [reconnected.diagnostics.transport, ...survivorHistories]) {
      assert(state.prediction.maxDepth <= 12);
      assert(state.prediction.peakBytes <= 8 * 1024 * 1024);
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS live snapshot reconnect",
      JSON.stringify({
        players,
        combat,
        retryCycles,
        allConditioned,
        responseMs,
        receivedAuthorityHz,
        survivorHistories,
        exhausted,
        replay,
        restoredProjectiles: await recovered.evaluate(() => globalThis.testRestoredProjectiles),
        resumeSlot,
        survivors: await Promise.all(survivors.map(confirmed)),
        dropTick,
        snapshotTick: reconnected.diagnostics.snapshotTick,
        snapshotBytes: reconnected.diagnostics.snapshotBytes,
        caughtUpTick: reconnected.diagnostics.recoveredTick,
        replayMs: reconnected.diagnostics.replayMs,
        sameTickCount: common.length,
        presentationTicks: presentation.ticks.length,
        mixerStarts: presentation.sounds.length,
        survivor: await confirmed(survivor),
      }),
    );
  } catch (error) {
    console.error("RECONNECT FAILURE", error);
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
