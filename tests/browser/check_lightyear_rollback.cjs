/* global Module, tm4Port */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: ["--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(
      new URL("?authority=1&checkpoint=1", process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/")
        .href,
    );
    await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 60000 });
    const result = await page.evaluate(async (endpoint) => {
      const check = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      const start = () => check(Module._WebNetRequestMatch(2, 0, 12345, -1), "C startup refused");
      const { attachRollbackProbe } = await import("/rollback-probe.js");
      const contactCorrection = { from: 59, through: 69, buttons: 0x8040 };
      const spawnCorrection = { from: 70, through: 78, buttons: 0x40 };
      const projectileCorrection = { from: 80, through: 92, buttons: 0x2040 };
      const secondVolley = { from: 109, through: 120, buttons: 0x42 };
      const expiryCorrection = { from: 141, through: 151, buttons: 0x40 };
      const corrections = [
        contactCorrection,
        spawnCorrection,
        projectileCorrection,
        secondVolley,
        expiryCorrection,
      ];
      const steering = (tick) => (tick % 64 < 32 ? 0x8000 : 0x2000);
      const localInput = (tick) => {
        if (tick < 56) return 0x40 | steering(tick);
        if (tick >= 145) return 0x2;
        return tick >= 64 ? 0x2 | (tick % 12 === 0 ? 0x1 : 0) : 0;
      };
      const remoteInput = (tick) => {
        if (tick < 56) return 0x40 | (steering(tick) ^ 0xa000);
        return (
          corrections.find(({ from, through }) => tick >= from && tick < through)?.buttons ?? 0
        );
      };
      const fixture = (tick) => {
        if (tick === 60) check(Module._WebTestPlaceWeaponTarget(128) > 0, "contact fixture failed");
        if (tick === 110) check(Module._WebTestPlaceWeaponTarget(500) > 0, "target fixture failed");
        if (tick === 145) check(Module._WebTestAimAtDestroyable(), "world fixture failed");
      };
      const state = () => {
        check(
          Module._WebNetCaptureState(),
          "canonical capture refused at " + tm4Port.netMatch.tick,
        );
        Module._WebTestLocalCheckpointProjectiles();
        const tick = tm4Port.netMatch.tick;
        const worldAlive = tick > 145 ? !!Module._WebTestDestroyablePresent() : true;
        const geometry =
          tick > 145
            ? [
                tm4Port.testDestroyable.enabledFaces,
                tm4Port.testDestroyable.collisionEnabled,
                tm4Port.testDestroyable.collisionOwned,
              ]
            : [];
        const bytes = tm4Port.netCapturedState;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return {
          tick,
          digest: tm4Port.netMatch.digest,
          sections: tm4Port.netMatch.sections,
          bytes,
          random: view.getUint32(4, true),
          geometry,
          contact: !!Module._WebTestNetworkCarContact(),
          projectiles: [...tm4Port.testLiveProjectiles],
          bullets: tm4Port.bulletSpawns ?? 0,
          projectileSpawns: tm4Port.projectileSpawns ?? 0,
          projectileRemoved: tm4Port.projectileRemoved ?? 0,
          destroyed: !worldAlive,
          health: tm4Port.cars?.map((car) => car.health) ?? [],
        };
      };
      const equal = (actual, expected) =>
        actual.digest === expected.digest &&
        actual.sections.every((section, i) => section === expected.sections[i]) &&
        actual.bytes.length === expected.bytes.length &&
        actual.bytes.every((byte, i) => byte === expected.bytes[i]);
      const compare = (expected, actual) => {
        check(equal(actual, expected), "canonical state differs at tick " + actual.tick);
        check(
          actual.geometry.join() === expected.geometry.join(),
          "scenery state differs at tick " + actual.tick,
        );
      };
      const runReference = (end) => {
        start();
        const initial = state();
        const history = [initial];
        for (let tick = 0; tick < end; ++tick) {
          fixture(tick);
          check(Module._WebNetSetInput(tick, 0, localInput(tick), 0, 0), "reference slot zero");
          check(Module._WebNetSetInput(tick, 1, remoteInput(tick), 0, 0), "reference slot one");
          check(Module._WebNetQueueTick(tick), "reference step " + tick);
          history.push(state());
        }
        Module._WebNetCancelMatch();
        return history;
      };
      const end = 280;
      const reference = runReference(end);
      const worldDestroyedAt = reference.findIndex((entry) => entry.destroyed);
      check(worldDestroyedAt > 148, "ordinary gunfire did not destroy scenery");
      const worldCorrection = {
        from: worldDestroyedAt - 3,
        through: worldDestroyedAt + 3,
        buttons: 0x2040,
      };
      const afterWorld = {
        from: worldDestroyedAt + 4,
        through: worldDestroyedAt + 10,
        buttons: 0x8000,
      };
      corrections.push(worldCorrection, afterWorld);
      const expected = runReference(end);
      check(
        expected[projectileCorrection.from].projectiles.length > 0,
        "no live restore projectile",
      );
      check(
        expected
          .slice(contactCorrection.from, contactCorrection.through + 1)
          .some((entry) => entry.contact),
        "correction did not span car contact",
      );
      check(
        expected[worldCorrection.through].destroyed && !expected[worldCorrection.from].destroyed,
        "correction did not span world destruction",
      );

      const events = Object.fromEntries(
        ["projectileSpawns", "projectileRemoved", "bullets"].map((key) => [
          key,
          corrections.reduce(
            (sum, { from, through }) => sum + expected[through][key] - expected[from][key],
            0,
          ),
        ]),
      );
      check(
        events.projectileSpawns > 0 && events.projectileRemoved > 0 && events.bullets > 0,
        "native corrections need to span actual projectile creation, destruction, and gunfire",
      );
      check(
        corrections.some(({ from, through }) =>
          expected[through].health.some((health, slot) => health < expected[from].health[slot]),
        ),
        "native corrections need to span gameplay damage",
      );
      check(
        expected[worldCorrection.from].random !== expected[worldCorrection.through].random,
        "scenery destruction did not consume gameplay RNG",
      );

      start();
      Module.FS.rename("/DATA/GAME.MR", "/DATA/GAME.MR.rollback-probe");
      const originalCar = Module._WebTestReplayCarAddress();
      const restores = [];
      const replayedTicks = [];
      const captures = { count: 0, peakBytes: 0, peakSnapshotBytes: 0, elapsedMs: 0, replayMs: 0 };
      let restoreStarted = 0;
      let stepMs = 0;
      let published = 0;
      let active;
      tm4Port.netMatchTick = () => {
        published++;
      };
      const probe = await attachRollbackProbe(Module, endpoint, {
        beforeStep: fixture,
        captured(tick, bytes, storage, duration) {
          ++captures.count;
          captures.peakBytes = Math.max(captures.peakBytes, storage);
          captures.peakSnapshotBytes = Math.max(captures.peakSnapshotBytes, bytes);
          captures.elapsedMs += duration;
          if (active) {
            captures.replayMs += duration;
            if (tick === active.through)
              restores.at(-1).replayWallMs = performance.now() - restoreStarted;
          }
        },
        restored(tick, elapsedMs) {
          restoreStarted = performance.now() - elapsedMs;
          check(active && tick === active.from, "unexpected native restore tick " + tick);
          const restored = state();
          compare(expected[tick], restored);
          check(Module._WebTestReplayCarAddress() === originalCar, "C arena moved");
          restores.push({
            tick,
            depth: active.through - tick,
            elapsedMs,
            live: restored.projectiles.length,
          });
        },
        stepped(tick, replaying, duration) {
          if (replaying) {
            compare(expected[tick], state());
            replayedTicks.push(tick);
            stepMs += duration;
          }
        },
      });
      try {
        const until = async (condition, advance = false) => {
          const timeout = performance.now() + 8000;
          while (!condition()) {
            check(performance.now() < timeout, "native probe timed out");
            probe.pump(advance);
            await new Promise((resolve) => setTimeout(resolve, 4));
          }
        };
        await until(probe.ready, true);
        const base = probe.arm();
        let confirmed = 0;
        const sendThrough = async (through) => {
          const buttons = Array.from({ length: through - confirmed }, (_, i) =>
            remoteInput(confirmed + i),
          );
          probe.sendRemote(base + through, buttons);
          await until(() => probe.confirmed() === base + through);
          confirmed = through;
        };
        let tick = 0;
        for (const correction of corrections) {
          while (confirmed < correction.from) {
            const next = Math.min(confirmed + probe.depth, correction.from);
            await sendThrough(next);
            for (; tick < confirmed; ++tick)
              probe.pump(true, { buttons: localInput(tick), axes: 0, analog: false });
          }
          compare(expected[tick], state());
          for (; tick < correction.through; ++tick)
            probe.pump(true, { buttons: localInput(tick), axes: 0, analog: false });
          check(
            !equal(expected[tick], state()),
            "fixture produced no predicted divergence at " + tick,
          );
          active = correction;
          const before = replayedTicks.length;
          await sendThrough(tick);
          check(
            replayedTicks.length - before === correction.through - correction.from,
            "Lightyear replayed an unexpected number of ticks",
          );
          compare(expected[tick], state());
          active = undefined;
        }
        check(
          restores.find(({ tick }) => tick === projectileCorrection.from)?.live > 0,
          "native rollback did not restore a live projectile",
        );
        check(
          Module._WebTestNetworkPlaybackVoices() === 0 && tm4Port.levelFrames === 0,
          "headless prediction reached presentation",
        );
        check(
          published === tick && probe.replayed() === replayedTicks.length,
          "rollback re-published ticks or skipped native steps",
        );
        check(captures.peakBytes < 9 * 1024 * 1024, "checkpoint history exceeded its bound");

        const late = confirmed;
        for (; tick < late + probe.depth + 1; ++tick)
          probe.pump(true, { buttons: localInput(tick), axes: 0, analog: false });
        const beforeLate = state();
        check(
          !Module._WebNetRestoreLocalTick(late) &&
            tm4Port.localCheckpointError === "checkpoint tick is outside retained history",
          "C still retained an expired checkpoint",
        );
        compare(beforeLate, state());
        const replayCount = probe.replayed();
        probe.sendRemote(base + late + 1, [0]);
        let rejected = false;
        try {
          await until(() => probe.confirmed() === base + late + 1);
        } catch (error) {
          rejected = String(error).includes(
            "Lightyear rejected the input correction outside rollback history",
          );
        }
        check(
          rejected && probe.replayed() === replayCount,
          "old input was not rejected by native history",
        );
        compare(beforeLate, state());
        check(published === tick, "refused correction published a tick");
        return {
          restores,
          replayedTicks: replayedTicks.length,
          worldDestroyedAt,
          events,
          captures,
          stepMs,
          published,
        };
      } finally {
        delete tm4Port.netMatchTick;
        Module.FS.rename("/DATA/GAME.MR.rollback-probe", "/DATA/GAME.MR");
        probe.close();
        Module._WebNetCancelMatch();
        check(!Module._WebNetLocalCheckpointStorageBytes(), "checkpoint history survived teardown");
      }
    }, process.env.TM4_ROLLBACK_ENDPOINT ?? "ws://127.0.0.1:19326");
    assert.deepEqual(errors, []);
    console.log("PASS native Lightyear rollback", JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
