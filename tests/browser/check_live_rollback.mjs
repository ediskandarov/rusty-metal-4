/* global Module, tm4Port */
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { readyInLobby } from "./network_lobby.mjs";
import { fixtureTape, observeAcceptedFrames } from "./simulation_reference.mjs";

const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
const endpoint = process.env.TM4_MATCH_ENDPOINT;
const latency = Number(process.env.TM4_LIVE_DELAY_MS ?? 72);
const jitter = Number(process.env.TM4_LIVE_JITTER_MS ?? 12);
const sustain = Number(process.env.TM4_LIVE_SUSTAIN_TICKS ?? 45);
const screenshots = process.env.TM4_LIVE_SCREENSHOT_DIR;
const testCar = process.env.TM4_TEST_CAR;
const testWorld = process.env.TM4_TEST_WORLD;
const oil = testWorld === "The Oil Rig";
const neon = testWorld === "Neon City";
const carnival = testWorld === "The Carnival";
const detonateAfter = Number(process.env.TM4_LIVE_DETONATE_MS ?? 0);
const specialUsesEffects = process.env.TM4_LIVE_SPECIAL_EFFECT === "1";
const targetDistance = Number(process.env.TM4_TARGET_DISTANCE ?? 500);
const testGrab = process.env.TM4_TEST_GRAB === "1";
const projectileTarget = process.env.TM4_TEST_PROJECTILE_TARGET;
assert(endpoint, "A fresh prediction-enabled match server is required");

async function load(page, url) {
  await page.goto(url.href);
  await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
    timeout: 60_000,
    polling: 100,
  });
}

async function instruments(page, client) {
  await page.evaluate(
    async ({ client, latency, jitter, targetDistance, testGrab, projectileTarget }) => {
      const trace = (globalThis.tm4LiveTrace = {
        captures: new Map(),
        fixtures: {},
        hud: new Map(),
        replayedHud: new Set(),
        keys: new Map(),
        firstDrive: null,
        steps: 0,
        publications: 0,
        replay: false,
        repeated: 0,
        contact: false,
        destroyed: false,
        replayDestruction: false,
        replayImpacts: 0,
        replayProjectiles: 0,
        effects: 0,
        replayEffects: 0,
        replayGrabs: 0,
        replayHelicopters: 0,
        replayPathHits: 0,
        grabDamage: 0,
        frozen: false,
        replayFreeze: false,
        damage: false,
      });
      if (client) {
        Module._WebSetRenderLimit(30);
        tm4Port.motionSamples = [];
        Module._WebTestCaptureMotion(1);
        const confirm = Module._WebNetConfirmPresentationTick;
        Module._WebNetConfirmPresentationTick = (tick) => {
          const count = confirm(tick);
          if (count) trace.hud.set(tick, [count, confirm(tick)]);
          return count;
        };
        const bindings = await import(new URL("network/tm4_network.js", document.baseURI).href);
        const update = bindings.NetworkClient.prototype.update;
        bindings.NetworkClient.prototype.update = function () {
          if (this.connected() && !trace.conditioned) {
            this.condition(latency, jitter);
            trace.conditioned = true;
          }
          if (trace.stallUntil > performance.now()) return "[]";
          return update.call(this);
        };
      }
      window.addEventListener("keydown", ({ key }) => trace.keys.set(key, performance.now()), true);
      const restore = Module._WebNetRestoreLocalTick;
      Module._WebNetRestoreLocalTick = (tick) => {
        const restored = restore(tick);
        if (restored) {
          trace.replay = true;
          trace.sceneryAliveAtRestore = trace.world && !!Module._WebTestDestroyablePresent();
        }
        return restored;
      };
      const finish = Module._WebNetFinishLocalReplay;
      Module._WebNetFinishLocalReplay = () => {
        const result = finish();
        trace.replay = false;
        return result;
      };
      const step = Module._WebNetQueueTick;
      Module._WebNetQueueTick = (tick) => {
        const action = trace.fixtures[tick];
        if (action === "contact" && !Module._WebTestPlaceWeaponTarget(128))
          throw new Error("Contact fixture failed");
        if (action === "target" && !Module._WebTestPlaceWeaponTarget(targetDistance))
          throw new Error("Projectile fixture failed");
        if (action === "helicopter" && !Module._WebTestLaunchAtHelicopter())
          throw new Error("Helicopter fixture failed");
        if (
          (action === "train" || action === "ufo") &&
          !Module._WebTestApproachNeonObject(action === "ufo" ? 1 : 0)
        )
          throw new Error("Neon City fixture failed");
        if (action === "coaster" && !Module._WebTestApproachPathObject(0))
          throw new Error("Coaster fixture failed");
        if (action === "grab" && Module._WebTestPlaceAugerTarget() <= 0)
          throw new Error("Grab fixture failed");
        if (action === "world" && !Module._WebTestAimAtWeakDestroyable())
          throw new Error("World fixture failed");
        if (action === "wall" && !Module._WebTestAimAtDestroyable())
          throw new Error("Wall fixture failed");
        if (action === "world") {
          trace.world = true;
          trace.worldTick = tick;
        }
        if (client && tick >= trace.worldTick + 3 && tick < trace.worldTick + 20) {
          Module._WebTestNetworkHudMessages(1, trace.replay ? 1 : 2);
          if (trace.replay) trace.replayedHud.add(tick + 1);
        }
        const frozenBefore = projectileTarget && Module._WebTestFrozenFaceTicks(1) > 0;
        if (projectileTarget && !frozenBefore)
          Module.ccall("WebTestPlaceProjectileTarget", "number", ["string"], [projectileTarget]);
        const publishes = tm4Port.testSimulationTick;
        tm4Port.testSimulationTick = () => {
          ++trace.publications;
          publishes?.();
        };
        const previousImpacts = tm4Port.projectileImpacts ?? 0;
        const previousProjectiles = tm4Port.projectileSpawns ?? 0;
        const previousHelicopters = tm4Port.helicopterRemoved ?? 0;
        const pathHits = () => (tm4Port.trainPlayerHits ?? 0) + (tm4Port.coasterPlayerHits ?? 0);
        const previousPathHits = pathHits();
        const previousEffects = trace.effects;
        const previousHealth = tm4Port.cars?.map(({ health }) => health);
        let result;
        try {
          result = step(tick);
        } finally {
          tm4Port.testSimulationTick = publishes;
        }
        if (!result) return result;
        ++trace.steps;
        if (projectileTarget && !frozenBefore && Module._WebTestFrozenFaceTicks(1) > 0) {
          trace.frozen = true;
          trace.replayFreeze ||= trace.replay;
        }
        trace.effects =
          (tm4Port.shockwaveSpawns ?? 0) +
          (tm4Port.raySpawns ?? 0) +
          (tm4Port.lightningEmitters ?? 0) +
          (tm4Port.flameSpawns ?? 0);
        if (trace.replay) {
          ++trace.repeated;
          trace.replayImpacts += (tm4Port.projectileImpacts ?? 0) - previousImpacts;
          trace.replayProjectiles += (tm4Port.projectileSpawns ?? 0) - previousProjectiles;
          trace.replayEffects += trace.effects - previousEffects;
          trace.replayHelicopters += (tm4Port.helicopterRemoved ?? 0) - previousHelicopters;
          trace.replayPathHits += pathHits() - previousPathHits;
        }
        if (testGrab && Module._WebTestReadCarGrab() && tm4Port.carGrab.holding) {
          const health = tm4Port.carGrab.health;
          trace.grabInitialHealth ??= health;
          trace.grabDamage = Math.max(trace.grabDamage, trace.grabInitialHealth - health);
          if (trace.replay) ++trace.replayGrabs;
        }
        trace.damage ||=
          !!previousHealth &&
          tm4Port.cars?.some(({ health }, index) => health < previousHealth[index]);
        const { digest, sections } = tm4Port.netMatch;
        if (!client) {
          if (trace.captures.size === 512)
            trace.captures.delete(trace.captures.keys().next().value);
          trace.captures.set(tick + 1, {
            digest,
            sections,
            time: performance.timeOrigin + performance.now(),
          });
        }
        trace.contact ||= !!Module._WebTestNetworkCarContact();
        if (trace.world && !Module._WebTestDestroyablePresent()) {
          trace.destroyed = true;
          trace.replayDestruction ||= trace.replay && trace.sceneryAliveAtRestore;
        }
        const slot = tm4Port.netViewSlot;
        const car = tm4Port.cars?.[slot];
        if (
          client &&
          trace.keys.has("x") &&
          !trace.firstDrive &&
          !trace.replay &&
          car?.throttle > 0
        ) {
          trace.firstDrive = {
            tick: tick + 1,
            confirmed: tm4Port.netConfirmedTick ?? 0,
            latencyMs: performance.now() - trace.keys.get("x"),
            time: performance.timeOrigin + performance.now(),
          };
        }
        return result;
      };
    },
    { client, latency, jitter, targetDistance, testGrab, projectileTarget },
  );
}

async function sceneColors(page, name) {
  const png = await page.screenshot(screenshots ? { path: screenshots + "/" + name + ".png" } : {});
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = "data:image/png;base64," + base64;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 100;
    const context = canvas.getContext("2d");
    context.drawImage(
      image,
      image.width / 4,
      image.height / 4,
      image.width / 2,
      image.height / 2,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 4)
      colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    return colors.size;
  }, png.toString("base64"));
}

const summary = (page) =>
  page.evaluate(() => ({
    status: document.querySelector("#status")?.textContent,
    slot: tm4Port.netViewSlot,
    head: tm4Port.netMatch?.tick,
    confirmed: tm4Port.netConfirmedTick,
    server: tm4Port.netMatchServerState,
    transport: tm4Port.netDiagnostics?.transport,
    cost: tm4Port.netPredictionCost,
    audio: {
      starts: tm4Port.predictionSoundStarts,
      duringReplay: tm4Port.predictionReplaySoundStarts ?? 0,
      reused: tm4Port.rollbackVoicesReused ?? 0,
    },
    frames: tm4Port.levelFrames,
    firstDrive: globalThis.tm4LiveTrace.firstDrive,
    contact: globalThis.tm4LiveTrace.contact,
    destroyed: globalThis.tm4LiveTrace.destroyed,
    damage: globalThis.tm4LiveTrace.damage,
    replayDestruction: globalThis.tm4LiveTrace.replayDestruction,
    replayImpacts: globalThis.tm4LiveTrace.replayImpacts,
    replayProjectiles: globalThis.tm4LiveTrace.replayProjectiles,
    effects: globalThis.tm4LiveTrace.effects,
    replayEffects: globalThis.tm4LiveTrace.replayEffects,
    replayGrabs: globalThis.tm4LiveTrace.replayGrabs,
    replayHelicopters: globalThis.tm4LiveTrace.replayHelicopters,
    helicopters: tm4Port.helicopterRemoved ?? 0,
    replayPathHits: globalThis.tm4LiveTrace.replayPathHits,
    pathHits: (tm4Port.trainPlayerHits ?? 0) + (tm4Port.coasterPlayerHits ?? 0),
    ufoCaptures: tm4Port.ufoCaptures ?? 0,
    grabDamage: globalThis.tm4LiveTrace.grabDamage,
    frozen: globalThis.tm4LiveTrace.frozen,
    replayFreeze: globalThis.tm4LiveTrace.replayFreeze,
    steps: globalThis.tm4LiveTrace.steps,
    repeated: globalThis.tm4LiveTrace.repeated,
    publications: globalThis.tm4LiveTrace.publications,
    bullets: tm4Port.bulletSpawns ?? 0,
    projectiles: tm4Port.projectileSpawns ?? 0,
    impacts: tm4Port.projectileImpacts ?? 0,
    removed: tm4Port.projectileRemoved ?? 0,
  }));

const browser = await launchBrowser({
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-frame-rate-limit",
  ],
});
const [reference, ...players] = await Promise.all(
  Array.from({ length: 3 }, () => browser.newPage({ viewport: { width: 1280, height: 800 } })),
);
const errors = [];
for (const page of [reference, ...players])
  page.on("pageerror", (error) => errors.push(error.message));
try {
  await reference.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
  });
  await load(reference, new URL("?simulation-reference=1", site));
  await instruments(reference, false);
  const schedule = await fixtureTape({
    cars: testCar ? [testCar, testCar === "Pizza Boy" ? "Orbital" : "Pizza Boy"] : undefined,
    world: testWorld,
    projectileTarget,
  });
  const observation = await observeAcceptedFrames(reference, players);
  const target = new URL(site);
  target.searchParams.set("match", endpoint);
  await load(players[0], target);
  await instruments(players[0], true);
  const waiting = players[0].locator("#car-lobby");
  await waiting.waitFor({ state: "visible", timeout: 60000 });
  assert(await waiting.isVisible());
  await load(players[1], target);
  await instruments(players[1], true);
  await Promise.all(players.map(readyInLobby));
  const waitConfirmed = (page, targetTick, timeout = 12_000) =>
    page.waitForFunction((tick) => (tm4Port.netConfirmedTick ?? 0) >= tick, targetTick, {
      timeout,
    });
  await Promise.all(players.map((page) => waitConfirmed(page, 35)));
  const colors = [];
  for (const player of players) {
    await player.bringToFront();
    assert(await player.locator('#status[data-match-state="playing"]').isVisible());
    const count = await sceneColors(player, "opening-" + colors.length);
    assert(count > 64, "The gameplay scene is blank or flat (" + count + " colors)");
    colors.push(count);
  }
  const initial = await Promise.all(players.map(summary));
  assert.deepEqual(initial.map(({ slot }) => slot).sort(), [0, 1]);
  const shooter = players[initial.findIndex(({ slot }) => slot === 0)];
  const remoteDriver = players.find((player) => player !== shooter);
  await shooter.evaluate(() => Module._WebSetRenderLimit(60));

  for (const player of players) {
    await player.bringToFront();
    await player.locator("canvas").focus();
    await player.keyboard.down("x");
    await player.waitForFunction(() => globalThis.tm4LiveTrace.firstDrive, null, {
      timeout: 3500,
    });
    const { firstDrive } = await summary(player);
    assert(firstDrive.latencyMs < 100, JSON.stringify(firstDrive));
    assert(firstDrive.tick > firstDrive.confirmed, JSON.stringify(firstDrive));
    await reference.waitForFunction(
      (tick) => globalThis.tm4LiveTrace.captures.has(tick),
      firstDrive.tick,
      { polling: 100, timeout: 4000 },
    );
    const committed = await reference.evaluate(
      (tick) => globalThis.tm4LiveTrace.captures.get(tick).time,
      firstDrive.tick,
    );
    assert(
      firstDrive.time < committed,
      "Prediction did not precede accepted-frame reference playback",
    );
    await player.waitForTimeout(100);
    await player.keyboard.up("x");
  }

  await shooter.bringToFront();
  await shooter.locator("canvas").focus();
  await shooter.keyboard.down("x");
  await shooter.waitForTimeout(450);
  await shooter.evaluate(() => {
    Module._WebSetRenderLimit(120);
    globalThis.tm4LiveTrace.fastDraw = [tm4Port.levelFrames, performance.now()];
  });
  await shooter.waitForTimeout(220);
  await shooter.keyboard.down("ArrowRight");
  await shooter.waitForTimeout(140);
  await shooter.keyboard.up("ArrowRight");
  await shooter.keyboard.down("ArrowLeft");
  await shooter.waitForTimeout(220);
  await shooter.keyboard.up("ArrowLeft");
  await shooter.keyboard.up("x");
  const fastDraw = await shooter.evaluate(() => {
    const [firstFrame, firstTime] = globalThis.tm4LiveTrace.fastDraw;
    const lastFrame = tm4Port.levelFrames;
    globalThis.tm4LiveTrace.fastDraw.push(lastFrame);
    Module._WebSetRenderLimit(60);
    return (1000 * (lastFrame - firstFrame)) / (performance.now() - firstTime);
  });

  const fixture = async (action, lead = 15) => {
    const tick = await reference.evaluate((lead) => tm4Port.netMatch.tick + lead, lead);
    await schedule(tick, action, targetDistance);
    await Promise.all(
      [reference, ...players].map((page) =>
        page.evaluate(
          ([tick, action]) => {
            globalThis.tm4LiveTrace.fixtures[tick] = action;
          },
          [tick, action],
        ),
      ),
    );
    return tick;
  };
  const validate = async (page) => {
    const local = await summary(page);
    await reference.waitForFunction(
      (tick) => globalThis.tm4LiveTrace.captures.has(tick),
      local.confirmed,
    );
    const expected = await reference.evaluate(
      (tick) => globalThis.tm4LiveTrace.captures.get(tick),
      local.confirmed,
    );
    assert.deepEqual(local.server.sections, expected.sections);
    assert.equal(local.server.digest, expected.digest);
    assert(local.frames > 0);
    if (!testWorld) assert(local.contact);
    if (!testCar && !testWorld) assert(local.destroyed);
    assert(local.transport.prediction.rollbacks > 0 && local.repeated > 0);
    assert(
      local.transport.prediction.maxDepth <= 12 &&
        local.transport.prediction.peakBytes < 9 * 1024 * 1024,
    );
    assert.equal(local.publications, local.steps - local.repeated);
    assert.equal(local.audio.duringReplay, 0);
    assert(local.audio.starts > 0);
    return local;
  };
  if (oil) {
    const fire = await fixture("helicopter", 20);
    await remoteDriver.bringToFront();
    await remoteDriver.locator("canvas").focus();
    await remoteDriver.waitForFunction((tick) => tm4Port.netMatch.tick >= tick, fire - 3);
    await remoteDriver.keyboard.down("ArrowRight");
    await remoteDriver.waitForTimeout(180);
    await remoteDriver.keyboard.up("ArrowRight");
    await reference.waitForFunction(() => tm4Port.helicopterRemoved === 1, null, {
      timeout: 8000,
      polling: 25,
    });
    const combat = await summary(reference);
    await Promise.all(players.map((page) => waitConfirmed(page, combat.head + 15)));
    const verified = await Promise.all(players.map(validate));
    assert(combat.impacts > 0);
    assert(verified.some((state) => state.replayHelicopters > 0));
    assert.ifError(observation.error);
    assert.deepEqual(errors, []);
    console.log(
      "PASS live Lightyear Oil Rig rollback",
      JSON.stringify({ latency, jitter, combat, verified }),
    );
  } else if (neon || carnival) {
    const approach = await fixture(neon ? "train" : "coaster", 20);
    await remoteDriver.bringToFront();
    await remoteDriver.locator("canvas").focus();
    await remoteDriver.waitForFunction((tick) => tm4Port.netMatch.tick >= tick, approach - 3);
    await remoteDriver.keyboard.down("ArrowRight");
    await remoteDriver.waitForTimeout(180);
    await remoteDriver.keyboard.up("ArrowRight");
    await reference.waitForFunction(
      () => (tm4Port.trainPlayerHits ?? 0) + (tm4Port.coasterPlayerHits ?? 0) > 0,
      null,
      { timeout: 8000, polling: 25 },
    );
    if (neon) {
      await fixture("ufo", 20);
      await reference.waitForFunction(() => tm4Port.ufoCapturedPlayer, null, {
        timeout: 35_000,
        polling: 50,
      });
    }
    const combat = await summary(reference);
    await Promise.all(players.map((page) => waitConfirmed(page, combat.head + 15)));
    const verified = await Promise.all(players.map(validate));
    assert(combat.pathHits > 0 && (!neon || combat.ufoCaptures > 0));
    assert(verified.some((state) => state.replayPathHits > 0));
    assert.ifError(observation.error);
    assert.deepEqual(errors, []);
    console.log(
      "PASS live Lightyear " + testWorld + " rollback",
      JSON.stringify({ latency, jitter, combat, verified }),
    );
  } else {
    const tracking = await fixture("target");
    await Promise.all(players.map((page) => waitConfirmed(page, tracking + 2)));
    await remoteDriver.bringToFront();
    await remoteDriver.locator("canvas").focus();
    await remoteDriver.keyboard.down("x");
    await remoteDriver.keyboard.down("ArrowRight");
    await remoteDriver.waitForTimeout(340);
    await remoteDriver.keyboard.up("ArrowRight");
    await remoteDriver.keyboard.up("x");

    const contact = await fixture("contact");
    await Promise.all(players.map((page) => waitConfirmed(page, contact + 8)));
    const targetTick = await fixture("target");
    await Promise.all(players.map((page) => waitConfirmed(page, targetTick + 2)));
    await shooter.bringToFront();
    await shooter.locator("canvas").focus();
    await shooter.keyboard.down("w");
    if (testCar) await remoteDriver.keyboard.down("ArrowRight");
    await shooter.waitForTimeout(180);
    await shooter.keyboard.up("w");
    if (testCar) await remoteDriver.keyboard.up("ArrowRight");
    if (detonateAfter) {
      await shooter.waitForTimeout(detonateAfter);
      await Promise.all([shooter.keyboard.down("w"), remoteDriver.keyboard.down("ArrowRight")]);
      await shooter.waitForTimeout(140);
      await Promise.all([shooter.keyboard.up("w"), remoteDriver.keyboard.up("ArrowRight")]);
    }
    if (testGrab) {
      const grab = await fixture("grab");
      await reference.waitForFunction((tick) => tm4Port.netMatch.tick >= tick, grab - 2, {
        timeout: 5000,
        polling: 15,
      });
      await remoteDriver.keyboard.down("x");
      await remoteDriver.waitForTimeout(170);
      await remoteDriver.keyboard.up("x");
      await reference.waitForFunction(() => globalThis.tm4LiveTrace.grabDamage > 0, null, {
        timeout: 8000,
        polling: 100,
      });
    } else {
      await reference.waitForFunction(
        (effects) =>
          effects
            ? tm4Port.shockwaveRemoved ||
              tm4Port.rayRemoved ||
              tm4Port.lightningRemoved ||
              (tm4Port.flameSpawns && !Module._WebTestFlameEmitterCount())
            : tm4Port.projectileRemoved > 0,
        specialUsesEffects,
        { timeout: 8000, polling: 100 },
      );
    }
    if (testCar) {
      const combat = await summary(reference);
      await Promise.all(players.map((page) => waitConfirmed(page, combat.head + 15)));
      const verified = await Promise.all(players.map(validate));
      assert(
        verified.some(
          (state) =>
            state.replayProjectiles > 0 ||
            state.replayImpacts > 0 ||
            state.replayEffects > 0 ||
            state.replayGrabs > 0,
        ),
        "No rendered rollback replayed a projectile impact or special",
      );
      assert(combat.contact && combat.damage);
      if (projectileTarget) assert(combat.frozen && verified.some((state) => state.replayFreeze));
      if (testGrab) assert(combat.grabDamage > 0);
      else if (specialUsesEffects) assert(combat.effects > 0);
      else {
        assert(combat.projectiles > 0 && combat.removed > 0);
        assert(combat.impacts > 0 || combat.effects > 0);
      }
      assert.ifError(observation.error);
      assert.deepEqual(errors, []);
      console.log(
        "PASS live Lightyear roster rollback",
        JSON.stringify({ car: testCar, latency, jitter, combat, verified }),
      );
    } else {
      const world = await fixture("world");
      await Promise.all(players.map((page) => waitConfirmed(page, world + 2)));
      await shooter.keyboard.down("e");
      await reference.waitForFunction(() => globalThis.tm4LiveTrace.destroyed, null, {
        timeout: 12_000,
        polling: 100,
      });
      await shooter.keyboard.up("e");
      const destroyed = await summary(reference);
      await Promise.all(players.map((page) => waitConfirmed(page, destroyed.head + sustain)));

      const verified = await Promise.all(players.map(validate));
      const hud = await Promise.all(
        players.map((player) =>
          player.evaluate(() => {
            const { hud, replayedHud } = globalThis.tm4LiveTrace;
            return [...replayedHud].sort((a, b) => a - b).map((tick) => [tick, hud.get(tick)]);
          }),
        ),
      );
      assert(hud[1].length, "Expected at least one corrected HUD tick");
      assert(
        hud[0].every(([, count]) => !count),
        "A HUD event leaked to the other slot",
      );
      for (const [, count] of hud[1])
        assert.deepEqual(count, [1, 0], "Only the corrected HUD event may display, once");
      assert(
        fastDraw > 15 && fastDraw <= 33,
        "Network render must stay capped at 30 FPS: " + fastDraw.toFixed(1),
      );
      for (const player of players) {
        assert(
          await player.evaluate(
            () =>
              tm4Port.motionSamples.length > 0 &&
              tm4Port.motionSamples.every(
                ({ live, render, history }) =>
                  !history && live.every((value, index) => value === render[index]),
              ) &&
              typeof Module._WebNetSetPresentationPhase === "undefined" &&
              document.querySelector("#render-limit").disabled &&
              document.querySelector("#render-limit").value === "30" &&
              document.querySelector("#render-smoothing").disabled &&
              !document.querySelector("#render-smoothing").checked,
          ),
          "Network play must bypass interpolation and lock timing controls",
        );
      }
      const steadyColors = await sceneColors(shooter, "simulation-pose");
      assert(steadyColors > 64, "The scene is blank");
      const wall = await fixture("wall");
      await waitConfirmed(shooter, wall + 1);
      await shooter.keyboard.down("x");
      await shooter.waitForFunction(() => !!Module._WebTestNetworkWallContact(0), null, {
        timeout: 6000,
      });
      await shooter.keyboard.up("x");
      await validate(shooter);
      assert(
        verified.some((state) => state.replayDestruction),
        "No rendered rollback replayed the scenery destruction",
      );
      assert(
        destroyed.bullets > 0 &&
          destroyed.projectiles > 0 &&
          destroyed.impacts > 0 &&
          destroyed.removed > 0,
      );
      assert(destroyed.contact && destroyed.destroyed && destroyed.damage);

      const [stalled, survivor] = players;
      const before = await summary(reference);
      await stalled.evaluate(() => {
        globalThis.tm4LiveTrace.stallUntil = performance.now() + 1000;
      });
      await stalled.waitForFunction(() => !tm4Port.netMatch, null, { timeout: 7000 });
      const stalledState = await summary(stalled);
      assert.match(stalledState.status, /retained|resynchronized|simulation timeline|confirmation/);
      await waitConfirmed(survivor, before.head + 35);
      const after = await validate(survivor);
      const now = await summary(reference);
      const rate = await reference.evaluate(
        ([from, through]) => {
          const rows = globalThis.tm4LiveTrace.captures;
          return (1000 * (through - from)) / (rows.get(through).time - rows.get(from).time);
        },
        [before.head, now.head],
      );
      assert(rate > 27 && rate < 33, "Accepted stream advanced at " + rate);
      const late = await browser.newPage();
      try {
        await late.goto(target.href);
        const error = late.locator('#status[data-match-state="error"]');
        await error
          .filter({ hasText: "This match has already started" })
          .waitFor({ timeout: 60_000 });
        assert(await error.isVisible());
      } finally {
        await late.close();
      }
      await stalled.bringToFront();
      const restart = await stalled.evaluate(async () => {
        const retained = Module._WebNetLocalCheckpointStorageBytes();
        const ready = Module.ccall(
          "WebNetStartMatch",
          "number",
          ["number", "number", "number", "number", "number", "number", "string", "string"],
          [2, 3, 0, 12345, 0, 2, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
        );
        if (!ready) throw new Error("Could not restart rendered C fixture");
        globalThis.tm4LiveTrace.fixtures = {};
        globalThis.tm4LiveTrace.world = false;
        Module._WebSetRenderSmoothing(1);
        const step = (tick, buttons) => {
          if (
            !Module._WebNetSetInput(tick, 0, buttons, 0, 0) ||
            !Module._WebNetSetInput(tick, 1, 0, 0, 0) ||
            !Module._WebNetQueueTick(tick)
          )
            throw new Error("Could not advance correction fixture");
        };
        for (let tick = 0; tick < 14; ++tick) step(tick, 0x40);
        if (!Module._WebNetRetainLocalCheckpoint(14))
          throw new Error("Could not retain correction fixture");
        const run = (buttons) => {
          for (let tick = 14; tick < 21; ++tick) step(tick, buttons);
        };
        const replay = (buttons) => {
          if (!Module._WebNetRestoreLocalTick(14))
            throw new Error("Could not restore correction fixture");
          run(buttons);
          const result = Module._WebNetFinishLocalReplay();
          if (!result) throw new Error("Could not finish correction fixture");
          return result;
        };
        run(0x40);
        const originalDigest = tm4Port.netMatch.digest;
        const noOpResult = replay(0x40);
        const noOpDigest = tm4Port.netMatch.digest;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const frame = tm4Port.levelFrames;
        await new Promise((resolve) => setTimeout(resolve, 150));
        const idleFrame = tm4Port.levelFrames;
        Module._WebNetCancelMatch();
        return {
          retained,
          ready,
          closed: !tm4Port.netMatch,
          originalDigest,
          noOpResult,
          noOpDigest,
          frame,
          idleFrame,
        };
      });
      assert.equal(restart.retained, 0);
      assert.equal(restart.ready, 1);
      assert(restart.closed);
      assert.equal(restart.noOpResult, 1);
      assert.equal(restart.noOpDigest, restart.originalDigest);
      assert.equal(
        restart.idleFrame,
        restart.frame,
        "Network rendering must wait for a new simulation step",
      );
      assert.ifError(observation.error);
      assert.deepEqual(errors, []);
      console.log(
        "PASS live Lightyear rollback",
        JSON.stringify({
          latency,
          jitter,
          colors,
          hud,
          steadyColors,
          fastDraw,
          noOpDigest: restart.noOpDigest,
          verified,
          survivor: after.confirmed,
          acceptedHz: rate,
          stalled: stalledState.status,
          referenceCombat: {
            bullets: destroyed.bullets,
            projectiles: destroyed.projectiles,
            impacts: destroyed.impacts,
            removed: destroyed.removed,
          },
        }),
      );
    }
  }
} catch (error) {
  console.error("LIVE ASSERTION", error);
  console.error(
    "LIVE STATES",
    await Promise.all([reference, ...players].map((page) => summary(page).catch(String))),
  );
  throw error;
} finally {
  await browser.close();
}
