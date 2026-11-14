/* Production Rust prediction + native Lightyear rollback + real browser C/Wasm. */
/* global Module, tm4Port */
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { serveHost } from "../../tools/network/serve.ts";
import { launchBrowser } from "./helpers/browser.mjs";

if (!process.env.TM4_DISC_DIR) throw new Error("Set TM4_DISC_DIR to your local disc folder");
const site = resolve("build/diagnostic/server-site/play");
const bundle = await Bun.build({
  entrypoints: [
    "packages/game-runtime/src/network/protocol.ts",
    "packages/game-runtime/src/network/livePrediction.ts",
  ],
  outdir: site + "/ffa-regression",
  target: "browser",
});
assert(bundle.success, String(bundle.logs));
const host = await serveHost({ site, api: "http://127.0.0.1:1", port: 0 });
const browser = await launchBrowser({ args: ["--mute-audio"] });
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(new URL("?session=1&checkpoint=1", host.url).href);
  await page.waitForFunction(() => !document.getElementById("disc-folder").disabled);
  await page.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
  await page.waitForFunction(
    () => globalThis.tm4Port?.compatibility && globalThis.tm4Port?.platformReady,
    null,
    { timeout: 60000 },
  );
  const result = await page.evaluate(async () => {
    const { configureMatch, applyMembership } = await import("/ffa-regression/protocol.js");
    const { attachLivePrediction } = await import("/ffa-regression/livePrediction.js");
    const bindings = await import("/network/tm4_network.js");
    await bindings.default();
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const id = (number) => number.toString(16).padStart(16, "0");
    const admit = (slot, participant) => ({
      kind: "admit",
      identity: { slot, participant: id(participant) },
      car: "Orbital",
    });
    const depart = (slot, participant) => ({
      kind: "depart",
      identity: { slot, participant: id(participant) },
    });
    const start = (timeLimitTicks = 100, fragLimit = 20) => ({
      mode: "ffa",
      limits: { timeLimitTicks, fragLimit },
      respawnDelayTicks: 90,
      capacity: 8,
      slots: [0, 1],
      participants: [id(1), id(2)],
      world: "Construction Yard",
      cars: ["Orbital", "Pizza Boy"],
      modelPool: ["Orbital", "Pizza Boy"],
      compatibility: tm4Port.compatibility,
      seed: 12345,
      epoch: 1,
      portable: false,
    });
    const canonical = () => {
      check(Module._WebNetCaptureState(), "C canonical capture");
      return Array.from(tm4Port.netCapturedState);
    };
    const equal = (expected, message) => {
      const actual = canonical();
      check(
        actual.length === expected.length && actual.every((byte, i) => byte === expected[i]),
        message,
      );
    };
    const step = (tick) => {
      for (let slot = 0; slot < 8; slot++)
        if (Module.ccall("WebNetSlotMask", "number", [], []) & (1 << slot))
          check(Module._WebNetSetInput(tick, slot, 0, 0, 0), "oracle input");
      check(Module._WebNetQueueTick(tick), "oracle tick");
    };
    const events = new Map([
      [4, [depart(1, 2)]],
      [5, [admit(1, 4)]],
    ]);
    check(configureMatch(Module, start(100, 1), 0), "oracle startup");
    const initial = canonical();
    const oracle = [initial];
    for (let tick = 0; tick < 8; tick++) {
      if (events.has(tick))
        check(applyMembership(Module, tick, events.get(tick)), "oracle membership");
      step(tick);
      oracle.push(canonical());
    }
    Module._WebNetCancelMatch();
    const run = (configuration = start()) => {
      check(configureMatch(Module, configuration, 0), "prediction startup");
      const bridge = attachLivePrediction(Module, tm4Port);
      const fixture = new bindings.MembershipPredictionFixture(JSON.stringify(configuration));
      const advance = (head) => {
        let returned = -1;
        for (let i = 0; i < 40 && returned < head; i++) returned = fixture.pump();
        check(
          returned === head,
          "prediction did not reach " + head + ": " + returned + " " + fixture.diagnostics(),
        );
      };
      const close = () => {
        fixture.free();
        bridge.close();
        Module._WebNetCancelMatch();
      };
      return { fixture, advance, close };
    };
    let active = run(start(4));
    active.fixture.controller(1, id(4));
    for (const [tick, changes] of events) active.fixture.plan(tick, JSON.stringify(changes));
    active.advance(7);
    check(
      tm4Port.netMatch.completion.tick === 4 && tm4Port.netMatch.completion.reasons === 1,
      "real timeout completion",
    );
    check(
      Module.ccall("WebNetSlotMask", "number", [], []) === 3,
      "terminal forecast changed roster",
    );
    check(!applyMembership(Module, 7, [depart(1, 2)]), "authority terminal departure fence");
    check(!applyMembership(Module, 7, [admit(2, 3)]), "authority terminal admission fence");
    let malformed = false;
    try {
      active.fixture.plan(8, JSON.stringify([{ ...admit(3, 6), car: "Unavailable" }]));
    } catch {
      malformed = true;
    }
    check(malformed, "terminal state hid invalid wire plan");
    active.close();
    // With an explicit one-frag fixture limit, a real projectile completes the predicted match. Authority then cancels
    // its admission, forcing native Lightyear rollback before that car ever existed.
    active = run(start(100, 1));
    equal(initial, "prediction initial state differs from oracle");
    active.fixture.controller(2, id(3));
    active.fixture.controller(1, id(4));
    active.fixture.plan(2, JSON.stringify([admit(2, 3)]));
    for (const [tick, changes] of events) active.fixture.plan(tick, JSON.stringify(changes));
    const queue = Module._WebNetQueueTick;
    const fragStep = (tick) => {
      if (tick === 3 && Module.ccall("WebNetSlotMask", "number", [], []) & 4) {
        const projectile = Module._WebTestCreateParticipantProjectile(2);
        check(projectile && Module._WebTestHitParticipant(projectile, 0), "real lethal projectile");
      }
      return queue(tick);
    };
    Module._WebNetQueueTick = fragStep;
    try {
      active.advance(6);
      check(
        tm4Port.netMatch.completion.tick === 4 && tm4Port.netMatch.completion.reasons === 2,
        "real predicted frag completion",
      );
      check(tm4Port.netMatch.scores[2].frags === 1, "C did not own the frag-limit score");
      check(
        Module.ccall("WebNetSlotMask", "number", [], []) === 7,
        "post-end forecast was applied",
      );
      active.fixture.plan(2, "[]");
      active.advance(8);
      check(!tm4Port.netMatch.completion.reasons, "correction did not undo completion");
      check(JSON.parse(active.fixture.diagnostics()).rollbacks > 0, "native rollback did not run");
      check(
        Module.ccall("WebNetParticipantIdentityPart", "number", ["number", "number"], [1, 0]) === 4,
        "deferred departure/admission lost identity",
      );
      equal(oracle[8], "corrected prediction differs from exact authoritative C replay");
    } finally {
      Module._WebNetQueueTick = queue;
      active.close();
    }
    active = run(start(100, 1));
    active.fixture.controller(2, id(3));
    active.fixture.plan(2, JSON.stringify([admit(2, 3)]));
    active.fixture.plan(4, JSON.stringify([depart(1, 99)]));
    Module._WebNetQueueTick = fragStep;
    try {
      active.advance(6);
      check(
        tm4Port.netMatch.completion.reasons === 2,
        "invalid-plan fixture did not reach provisional completion",
      );
      active.fixture.plan(2, "[]");
      let rejected = false;
      try {
        active.advance(8);
      } catch (error) {
        rejected = String(error).includes("refused an authoritative membership");
      }
      check(rejected, "correction hid an invalid deferred identity");
    } finally {
      Module._WebNetQueueTick = queue;
      active.close();
    }
    for (const changes of [[depart(1, 99)], [admit(1, 99)], [admit(2, 1)]]) {
      active = run();
      active.fixture.controller(changes[0].identity.slot, changes[0].identity.participant);
      active.fixture.plan(1, JSON.stringify(changes));
      let rejected = false;
      try {
        active.advance(3);
      } catch (error) {
        rejected = String(error).includes("refused an authoritative membership");
      }
      check(rejected, "invalid membership decision survived prediction");
      active.close();
    }
    return {
      timeout: true,
      correctedFrag: true,
      exactReplay: true,
      invalidDecisions: 4,
    };
  });
  assert.deepEqual(errors, []);
  console.log("PASS real prediction completion/membership regression", result);
} finally {
  await browser.close();
  await host.stop(true);
}
