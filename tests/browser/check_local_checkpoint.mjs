/* global Module, tm4Port */
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";

const browser = await launchBrowser();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(
    new URL(
      "?simulation-reference=1&checkpoint=1",
      process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/",
    ).href,
  );
  await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 60000 });
  const metrics = await page.evaluate(() => {
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const read = () => {
      check(Module._WebNetCaptureState(), "canonical capture refused at " + tm4Port.netMatch.tick);
      const { tick, sections, digest } = tm4Port.netMatch;
      return { tick, sections, digest, bytes: tm4Port.netCapturedState };
    };
    const random = ({ bytes }) => {
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return [data.getUint32(4, true), data.getUint32(8, true)];
    };
    const compare = (expected) => {
      const actual = read();
      check(actual.tick === expected.tick, "simulation tick differs");
      check(actual.digest === expected.digest, "digest differs at " + actual.tick);
      check(
        actual.sections.every((value, i) => value === expected.sections[i]),
        "subsystems differ at " + actual.tick,
      );
      check(
        actual.bytes.length === expected.bytes.length &&
          actual.bytes.every((byte, i) => byte === expected.bytes[i]),
        "canonical bytes differ at " + actual.tick,
      );
    };
    const start = () =>
      check(
        Module.ccall(
          "WebNetStartMatch",
          "number",
          ["number", "number", "number", "number", "number", "number", "string", "string"],
          [2, 3, 0, 12345, -1, 0, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
        ),
        "match start refused",
      );
    const projectiles = () => {
      Module._WebTestLocalCheckpointProjectiles();
      return tm4Port.testLiveProjectiles;
    };
    const step = (tick, buttons, other = 0) => {
      check(Module._WebNetSetInput(tick, 0, buttons, 0, 0), "slot zero input " + tick);
      check(Module._WebNetSetInput(tick, 1, other, 0, 0), "slot one input " + tick);
      check(Module._WebNetQueueTick(tick), "tick " + tick + " refused");
    };
    const combat = (tick) => {
      if (tick === 60) check(Module._WebTestPlaceWeaponTarget(128) > 0, "contact placement");
      if (tick === 110) check(Module._WebTestPlaceWeaponTarget(500) > 0, "target placement");
      if (tick === 220) check(Module._WebTestApproachCrane(0), "crane placement");
      const steering = tick % 64 < 32 ? 0x8000 : 0x2000;
      const first =
        tick < 56
          ? 0x40 | steering
          : tick >= 220
            ? 0x2000
            : tick >= 64
              ? 0x2 | (tick % 12 === 0 ? 0x1 : 0)
              : 0;
      const second =
        tick < 56 ? 0x40 | (steering ^ 0xa000) : tick >= 150 ? 0x40 | steering | 0x2 : 0;
      step(tick, first, second);
    };
    const capture = () => {
      const time = performance.now();
      const bytes = Module._WebNetCaptureLocalCheckpoint();
      const captureMs = performance.now() - time;
      check(bytes > 0, "local capture refused at " + tm4Port.netMatch.tick);
      return { bytes, captureMs };
    };
    const restore = (initial) => {
      const time = performance.now();
      check(Module._WebNetRestoreLocalCheckpoint(), "local restore refused");
      const restoreMs = performance.now() - time;
      compare(initial);
      return restoreMs;
    };

    start();
    let tick = 0;
    let contact = false;
    let moved = false;
    for (; tick < 105;) {
      combat(tick++);
      contact ||= !!Module._WebTestNetworkCarContact();
      moved ||= !!tm4Port.carThrottle && !!tm4Port.carSteering;
      if (tick >= 80 && projectiles().length) break;
    }
    const live = projectiles();
    check(live.length > 0, "checkpoint did not contain a live weapon projectile");
    check(moved && contact, "fixture needs steering, throttle and car contact");
    const saved = read();
    const savedAddress = Module._WebTestReplayCarAddress();
    const savedHealth = tm4Port.cars.map((car) => car.health);
    const cars = tm4Port.cars.map((car) => car.name);
    const impacts = tm4Port.projectileImpacts ?? 0;
    const removed = tm4Port.projectileRemoved ?? 0;
    const startedSpawns = tm4Port.projectileSpawns;
    Module.tm4CodeMods = { size: 1 };
    check(!Module._WebNetCaptureLocalCheckpoint(), "independent module capture accepted");
    delete Module.tm4CodeMods;
    const checkpoint = capture();
    let published = 0;
    tm4Port.testSimulationTick = () => {
      published++;
    };
    const expected = [];
    const end = 260;
    let firstProjectileExpired = false;
    for (let i = tick; i < end; i++) {
      combat(i);
      const active = projectiles();
      firstProjectileExpired ||= live.some((serial) => !active.includes(serial));
      expected.push(read());
    }
    check(
      firstProjectileExpired &&
        tm4Port.projectileSpawns > startedSpawns &&
        tm4Port.projectileImpacts > impacts &&
        tm4Port.projectileRemoved > removed,
      "combat needs projectile creation, impact and destruction after capture",
    );
    check(
      tm4Port.cars.some((car, i) => car.health < savedHealth[i]),
      "no car damage",
    );
    check(tm4Port.crane.controlled && tm4Port.crane.angle !== 0, "crane did not move");
    check(published === expected.length, "live ticks did not publish");
    const finalRandom = random(expected.at(-1));
    check(random(saved)[0] !== finalRandom[0], "combat did not consume gameplay RNG");
    check(Module._WebTestPerturbNetworkCar(1), "could not perturb car");
    check(
      read().bytes.some((byte, i) => byte !== expected.at(-1).bytes[i]),
      "canonical record missed car perturbation",
    );

    const replayMs = [];
    const restoreMs = [];
    Module.FS.rename("/DATA/GAME.MR", "/DATA/GAME.MR.rollback-test");
    for (let repeat = 0; repeat < 3; repeat++) {
      restoreMs.push(restore(saved));
      check(Module._WebTestReplayCarAddress() === savedAddress, "car allocation relocated");
      check(projectiles().join() === live.join(), "live projectile graph was not restored");
      let duration = 0;
      for (let i = tick; i < end; i++) {
        const before = performance.now();
        combat(i);
        duration += performance.now() - before;
        compare(expected[i - tick]);
      }
      replayMs.push(duration);
      check(
        Module._WebTestNetworkPlaybackVoices() === 0 && tm4Port.levelFrames === 0,
        "headless replay reached presentation",
      );
      check(published === expected.length, "replayed ticks published externally");
      check(Module._WebNetFinishLocalReplay(), "replay finish refused");
    }
    Module.FS.rename("/DATA/GAME.MR.rollback-test", "/DATA/GAME.MR");
    check(Module._WebNetSetInput(end, 0, 0, 0, 0), "staging first input refused");
    check(!Module._WebNetRestoreLocalCheckpoint(), "restored during partial input");
    check(Module._WebNetSetInput(end, 1, 0, 0, 0), "staged second input refused");
    check(Module._WebNetQueueTick(end), "staged input lost after refusal");
    check(published === expected.length + 1, "live publication did not resume");
    Module._WebNetCancelMatch();
    start();
    check(!Module._WebNetRestoreLocalCheckpoint(), "checkpoint survived match teardown");

    check(Module._WebTestAimAtDestroyable(), "world fixture could not find a destroyable");
    step(0, 0);
    const worldSaved = read();
    const worldInitial = { ...tm4Port.testDestroyable };
    check(
      worldInitial.enabledFaces && worldInitial.collisionEnabled && worldInitial.collisionOwned,
      "invalid initial world fixture",
    );
    const worldCheckpoint = capture();
    check(Module._WebTestPerturbLocalCheckpoint(), "world and RNG perturbation refused");
    const perturbed = read();
    const perturbedRandom = random(perturbed);
    check(
      random(worldSaved).every((seed, i) => seed !== perturbedRandom[i]),
      "canonical record missed RNG perturbation",
    );
    restore(worldSaved);
    Module._WebTestDestroyablePresent();
    check(
      tm4Port.testDestroyable.enabledFaces === worldInitial.enabledFaces &&
        tm4Port.testDestroyable.collisionEnabled &&
        tm4Port.testDestroyable.collisionOwned,
      "world flags did not restore",
    );
    check(Module._WebNetFinishLocalReplay(), "world replay finish refused");

    const world = [];
    let destroyed = false;
    for (let i = 1; i <= 180; i++) {
      step(i, 0x2);
      world.push(read());
      destroyed ||= Module._WebTestDestroyablePresent() === 0;
    }
    check(
      destroyed &&
        !tm4Port.testDestroyable.collisionOwned &&
        !tm4Port.testDestroyable.collisionEnabled &&
        !tm4Port.testDestroyable.enabledFaces,
      "live shots did not destroy world geometry",
    );
    restore(worldSaved);
    Module._WebTestDestroyablePresent();
    check(
      tm4Port.testDestroyable.alive &&
        tm4Port.testDestroyable.collisionOwned &&
        tm4Port.testDestroyable.enabledFaces === worldInitial.enabledFaces,
      "world object and its geometry were not brought back",
    );
    for (let i = 0; i < world.length; i++) {
      step(i + 1, 0x2);
      compare(world[i]);
    }
    check(Module._WebTestChangeCheckpointResources(), "resource guard fixture failed");
    check(
      !Module._WebNetRestoreLocalCheckpoint() &&
        tm4Port.localCheckpointError === "match resources changed since capture",
      "restore ignored resource heap activity",
    );
    compare(world.at(-1));
    check(Module._WebNetFinishLocalReplay(), "world replay finish refused");
    capture();
    check(Module._WebTestCheckpointWorldArenaOverlap(), "overlap fixture failed");
    check(
      !Module._WebNetRestoreLocalCheckpoint() &&
        tm4Port.localCheckpointError === "world mutation outside the resource arena",
      "restore accepted a simulation-arena address in the world undo log",
    );
    compare(world.at(-1));
    Module._WebNetCancelMatch();
    return {
      ...checkpoint,
      tick,
      cars,
      liveProjectiles: live.length,
      replayedTicks: expected.length,
      restoreMs,
      replayMs,
      worldBytes: worldCheckpoint.bytes,
      worldTicks: world.length,
    };
  });
  assert.deepEqual(errors, []);
  console.log("PASS local checkpoint and replay", JSON.stringify(metrics));
} finally {
  await browser.close();
}
