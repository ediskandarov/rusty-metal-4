/* global Module, tm4Port */
const assert = require("node:assert/strict");

async function instrument(page, { client = false, latency = 0, jitter = 0 } = {}) {
  await page.evaluate(
    async ({ client, latency, jitter }) => {
      const trace = (globalThis.tm4SessionTest = {
        actions: {},
        ranges: [],
        local: new Map(),
        verified: 0,
        firstVerified: null,
        lastVerified: 0,
        firstDrive: null,
        firstMotion: null,
        firstSteering: null,
        steerPressed: null,
        origin: null,
        pressed: null,
        steps: 0,
        publications: 0,
        replayed: 0,
        replay: false,
        samples: [],
        held: false,
        frozen: false,
        interrupted: false,
        replayInterrupted: false,
        deaths: false,
        damageEvents: 0,
        created: 0,
        destroyed: 0,
        maxProjectiles: 0,
      });
      window.addEventListener("keydown", ({ key }) => {
        if (key === "ArrowLeft") trace.steerPressed = performance.now();
        if (key === "x") {
          trace.pressed = performance.now();
          const car = tm4Port.cars?.[tm4Port.netViewSlot];
          if (car) trace.origin = [car.x, car.z];
        }
      });
      const restore = Module._WebNetRestoreLocalTick;
      Module._WebNetRestoreLocalTick = (tick) => {
        const result = restore(tick);
        if (result) trace.replay = true;
        return result;
      };
      const finish = Module._WebNetFinishLocalReplay;
      Module._WebNetFinishLocalReplay = () => {
        const result = finish();
        trace.replay = false;
        trace.lastObjects = null;
        return result;
      };
      const original = Module._WebNetQueueTick;
      Module._WebNetQueueTick = (tick) => {
        const action = trace.actions[tick];
        if (action) {
          let ok;
          if (action.kind === "pair") ok = Module._WebTestPlacePlayerTarget(...action.args);
          else if (action.kind === "death") ok = Module._WebTestPreparePlayerDuel(...action.args);
          else if (action.kind === "helicopter") ok = Module._WebTestLaunchAtHelicopter();
          else if (action.kind === "coaster") ok = Module._WebTestApproachPathObject(0);
          if (!ok) throw new Error("Combat fixture refused at " + tick + ": " + action.kind);
        }
        for (const range of trace.ranges)
          if (tick >= range.start && tick < range.end)
            Module.ccall(
              "WebTestPlacePlayerProjectileTarget",
              "number",
              ["number", "number", "string"],
              [range.source, range.target, range.name],
            );
        const publish = tm4Port.testSimulationTick;
        tm4Port.testSimulationTick = () => {
          trace.publications++;
          publish?.();
        };
        let result;
        try {
          result = original(tick);
        } finally {
          tm4Port.testSimulationTick = publish;
        }
        if (!result) return result;
        trace.steps++;
        if (trace.replay) trace.replayed++;
        const { digest, sections } = tm4Port.netMatch;
        trace.local.set(tick + 1, [digest, ...sections]);
        if (trace.local.size > 256) trace.local.delete(trace.local.keys().next().value);
        const previous = tm4Port.testCombatPlayers;
        Module._WebTestReadNetworkCombat();
        const players = tm4Port.testCombatPlayers;
        const objects = tm4Port.testCombatObjects;
        trace.maxProjectiles = Math.max(trace.maxProjectiles, objects.projectiles);
        if (!trace.replay) {
          if (trace.lastObjects) {
            const created = objects.serial - trace.lastObjects.serial;
            trace.created += created;
            trace.destroyed += trace.lastObjects.count + created - objects.count;
          }
          trace.lastObjects = objects;
        }
        if (previous)
          trace.damageEvents += players.filter(
            (player, index) => player.health < previous[index].health,
          ).length;
        trace.held ||= players.some(({ held }) => held);
        trace.frozen ||= players.some(({ freeze }) => freeze > 0);
        if (players[1]?.freeze > 0 && !players[1].held && trace.held) {
          trace.interrupted = true;
          trace.replayInterrupted ||= trace.replay;
        }
        trace.deaths ||= players.some(({ health }) => !health);
        if (
          trace.pressed !== null &&
          !trace.firstDrive &&
          !trace.replay &&
          tm4Port.cars?.[tm4Port.netViewSlot]?.throttle > 0
        )
          trace.firstDrive = {
            tick: tick + 1,
            confirmed: tm4Port.netConfirmedTick ?? 0,
            latencyMs: performance.now() - trace.pressed,
          };
        const car = tm4Port.cars?.[tm4Port.netViewSlot];
        if (
          trace.origin &&
          !trace.firstMotion &&
          !trace.replay &&
          car?.throttle > 0 &&
          (car.x !== trace.origin[0] || car.z !== trace.origin[1])
        )
          trace.firstMotion = {
            tick: tick + 1,
            confirmed: tm4Port.netConfirmedTick ?? 0,
            latencyMs: performance.now() - trace.pressed,
            steering: car.steering,
            delta: [car.x - trace.origin[0], car.z - trace.origin[1]],
          };
        if (trace.steerPressed !== null && !trace.firstSteering && !trace.replay && car?.steering)
          trace.firstSteering = {
            tick: tick + 1,
            confirmed: tm4Port.netConfirmedTick ?? 0,
            latencyMs: performance.now() - trace.steerPressed,
            steering: car.steering,
          };
        return result;
      };
      if (client) {
        const { NetworkClient } = await import("/network/tm4_network.js");
        const update = NetworkClient.prototype.update;
        NetworkClient.prototype.update = function () {
          if (!trace.conditioned && this.connected()) {
            this.condition(latency, jitter);
            trace.conditioned = true;
          }
          const raw = update.call(this);
          for (const message of JSON.parse(raw)) {
            if (message.type !== "frame") continue;
            const tick = message.tick + 1;
            const local = trace.local.get(tick);
            const expected = [message.state.digest, ...message.state.sections];
            if (!local || local.some((value, index) => value !== expected[index]))
              throw new Error("Independent local confirmation mismatch at " + tick);
            trace.verified++;
            trace.firstVerified ??= tick;
            trace.lastVerified = tick;
          }
          return raw;
        };
      }
    },
    { client, latency, jitter },
  );
}

async function sample(page) {
  return page.evaluate(() => {
    const t = globalThis.tm4SessionTest;
    return {
      status: document.querySelector("#status")?.textContent,
      phase: document.querySelector("#status")?.dataset.matchState,
      slot: tm4Port.netViewSlot,
      tick: tm4Port.netMatch?.tick,
      confirmed: tm4Port.netConfirmedTick ?? 0,
      verified: t.verified,
      firstVerified: t.firstVerified,
      lastVerified: t.lastVerified,
      firstDrive: t.firstDrive,
      firstMotion: t.firstMotion,
      firstSteering: t.firstSteering,
      steps: t.steps,
      replayed: t.replayed,
      publications: t.publications,
      held: t.held,
      frozen: t.frozen,
      interrupted: t.interrupted,
      replayInterrupted: t.replayInterrupted,
      deaths: t.deaths,
      damageEvents: t.damageEvents,
      roundFinished: tm4Port.netMatch?.roundFinished,
      created: t.created,
      destroyed: t.destroyed,
      maxProjectiles: t.maxProjectiles,
      helicopterRemoved: tm4Port.helicopterRemoved ?? 0,
      coasterHits: tm4Port.coasterPlayerHits ?? 0,
      combat: tm4Port.testCombatPlayers,
      transport: tm4Port.netDiagnostics?.transport,
      cost: tm4Port.netPredictionCost,
      audioDuringReplay: tm4Port.predictionReplaySoundStarts ?? 0,
      frames: tm4Port.levelFrames ?? 0,
      wasmBytes: tm4Port.testWasmBytes,
      now: performance.now(),
      renderLimit: tm4Port.renderLimit,
    };
  });
}

async function waitTick(page, tick, timeout = 30000) {
  await page.waitForFunction(
    (tick) =>
      (tm4Port.netConfirmedTick ?? tm4Port.netMatch?.tick ?? 0) >= tick ||
      document.querySelector("#status")?.dataset.matchState === "error",
    tick,
    { timeout, polling: 50 },
  );
  const state = await sample(page);
  assert((state.confirmed || state.tick) >= tick, JSON.stringify(state));
  assert.equal(state.phase, "playing", JSON.stringify(state));
  return state;
}

async function schedule(reference, pages, writeAction, kind, args = [], lead = 24) {
  const tick = await reference.evaluate((lead) => tm4Port.netMatch.tick + lead, lead);
  await writeAction(tick, kind, undefined, { args });
  await Promise.all(
    [reference, ...pages].map((page) =>
      page.evaluate(
        ({ tick, kind, args }) => {
          globalThis.tm4SessionTest.actions[tick] = { kind, args };
        },
        { tick, kind, args },
      ),
    ),
  );
  return tick;
}

async function drive(page) {
  await page.locator("canvas").focus();
  await page.keyboard.down("x");
  await page.waitForFunction(() => globalThis.tm4SessionTest.firstMotion, null, {
    timeout: 5000,
    polling: 5,
  });
  await page.keyboard.down("ArrowLeft");
  await page.waitForFunction(() => globalThis.tm4SessionTest.firstSteering, null, {
    timeout: 5000,
    polling: 5,
  });
  await page.keyboard.up("x");
  await page.keyboard.up("ArrowLeft");
  const state = await sample(page);
  assert(state.firstMotion.latencyMs < 100, JSON.stringify(state));
  assert(state.firstMotion.tick > state.firstMotion.confirmed, JSON.stringify(state));
  assert(
    state.firstSteering.latencyMs < 100 && state.firstSteering.tick > state.firstSteering.confirmed,
    JSON.stringify(state),
  );
  assert(state.firstDrive.tick > state.firstDrive.confirmed, JSON.stringify(state));
  return state.firstDrive;
}

module.exports = { instrument, sample, waitTick, schedule, drive };
