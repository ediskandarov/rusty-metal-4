/* global Module, tm4Port */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const errors = [];
    const scenery = process.env.TM4_PORTABLE_SCENERY === "1";
    const fall = process.env.TM4_PORTABLE_FALL === "1";
    const sceneryDamage = process.env.TM4_PORTABLE_SCENERY_DAMAGE === "1";
    const extenders = process.env.TM4_PORTABLE_EXTENDERS === "1";
    const triggers = (process.env.TM4_PORTABLE_TRIGGERS ?? "").split(",").filter(Boolean);
    assert(triggers.every((trigger) => ["teleporter", "jumppad"].includes(trigger)));
    const car = process.env.TM4_TEST_CAR;
    const projectileTarget = process.env.TM4_TEST_PROJECTILE_TARGET;
    const frozenSnapshot = process.env.TM4_PORTABLE_FROZEN === "1";
    const deathTest = process.env.TM4_PORTABLE_DUEL ?? "scheduled";
    assert(["scheduled", "natural", "0"].includes(deathTest));
    const duel = deathTest === "scheduled";
    const replayTicks = Number(process.env.TM4_PORTABLE_REPLAY_TICKS ?? 140);
    assert(Number.isInteger(replayTicks) && replayTicks >= 30 && replayTicks <= 640);
    const world = process.env.TM4_TEST_WORLD ?? "Construction Yard";
    const oil = world === "The Oil Rig";
    const neon = world === "Neon City";
    const carnival = world === "The Carnival";
    const oilDestroyed = oil && process.env.TM4_PORTABLE_OIL_DESTROYED === "1";
    const distance = Number(process.env.TM4_TARGET_DISTANCE ?? 600);
    const detonate = Number(process.env.TM4_TEST_DETONATE_TICK ?? 0);
    const radial = process.env.TM4_TEST_RADIAL_TARGET === "1";
    const grab = process.env.TM4_TEST_GRAB === "1";
    const triggerOnly = triggers.length > 0 && !scenery && !car && !oil && !neon && !carnival;
    const classes =
      fall || sceneryDamage
        ? []
        : (
            process.env.TM4_PORTABLE_OBJECTS ??
            (oilDestroyed
              ? "powerup"
              : oil
                ? "helicopter,weaponProjectile"
                : neon
                  ? "train,ufo"
                  : carnival
                    ? "coaster"
                    : triggerOnly
                      ? triggers.join(",")
                      : "weaponProjectile")
          ).split(",");
    const checkpointTick = Number(
      process.env.TM4_PORTABLE_CHECKPOINT_TICK ??
        (fall || sceneryDamage
          ? 90
          : oilDestroyed
            ? 241
            : oil
              ? 61
              : neon
                ? 981
                : carnival
                  ? 63
                  : scenery
                    ? 210
                    : car
                      ? 65
                      : 80),
    );
    assert(!(car && (scenery || oil || neon || carnival)));
    assert(
      Number.isInteger(checkpointTick) &&
        checkpointTick > 0 &&
        checkpointTick <= (neon ? 2000 : 260),
    );
    const open = async (shift) => {
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      if (shift)
        await page.addInitScript(() => {
          globalThis.tm4TestShiftResourceHeap = true;
        });
      await page.goto(new URL("?authority=1&checkpoint=1", site).href);
      await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
        timeout: 60_000,
      });
      await page.evaluate(
        ({
          shift,
          scenery,
          fall,
          sceneryDamage,
          triggerOnly,
          car,
          projectileTarget,
          duel,
          distance,
          detonate,
          radial,
          grab,
          classes,
          world,
          oil,
          neon,
          carnival,
        }) => {
          const select = (slot, name) =>
            Module.ccall("WebNetSelectCar", "number", ["number", "string"], [slot, name]);
          if (car && (!select(0, car) || (car === "Pizza Boy" && !select(1, "Orbital"))))
            throw new Error("Stock car selection refused");
          const worldIndex = Module.ccall("WebNetWorldIndex", "number", ["string"], [world]);
          if (worldIndex < 0) throw new Error("Unknown stock world");
          if (shift && !Module._malloc(2 * 1024 * 1024))
            throw new Error("Simulation arena shift refused");
          if (
            !Module._WebNetEnablePortableCheckpoint() ||
            !Module._WebNetRequestMatch(2, worldIndex, 12345, -1)
          )
            throw new Error("Match refused");
          tm4Port.step = (tick) => {
            let first = 0;
            let second = 0;
            const steeringPeriod = car || neon ? 40 : 64;
            const steering = tick % steeringPeriod < steeringPeriod / 2 ? 0x8000 : 0x2000;
            if (oil) {
              if (tick < 48) first = 0x40 | steering;
              if (tick === 60 && !Module._WebTestLaunchAtHelicopter())
                throw new Error("Helicopter fixture refused");
            } else if (neon) {
              if (tick < 42) first = 0x40 | steering;
              if (tick === 50 && !Module._WebTestApproachNeonObject(0))
                throw new Error("Train fixture refused");
              if (tick === 52 && !Module._WebTestApproachNeonObject(1))
                throw new Error("UFO fixture refused");
            } else if (carnival) {
              if (tick < 42) first = 0x40 | steering;
              if (tick === 64 && !Module._WebTestApproachPathObject(0))
                throw new Error("Coaster fixture refused");
            } else if (fall) {
              if (tick < 125) first = 0x40 | (tick % 40 < 20 ? 0x8000 : 0x2000);
            } else if (car) {
              if (tick === 48 && !Module._WebTestPlaceWeaponTarget(128))
                throw new Error("No contact target");
              if (grab && tick === 65) {
                tm4Port.testTargetHealth = Module._WebTestPlaceAugerTarget();
                if (tm4Port.testTargetHealth <= 0) throw new Error("No target to grab");
              }
              if (!grab && tick === 64) {
                if (radial) {
                  tm4Port.testTargetHealth = Module._WebTestPlaceRadialWeaponTarget(distance);
                } else {
                  if (Module._WebTestPlaceEnergyTarget(0) <= 0)
                    throw new Error("No open firing lane");
                  tm4Port.testTargetHealth = Module._WebTestPlaceWeaponTarget(distance);
                }
                if (tm4Port.testTargetHealth <= 0) throw new Error("No special target");
              }
              if (
                projectileTarget &&
                tick === 65 &&
                !Module.ccall(
                  "WebTestPlaceProjectileTarget",
                  "number",
                  ["string"],
                  [projectileTarget],
                )
              )
                throw new Error("No original projectile for the impact fixture");
              if (duel && tick === 115 && !Module._WebTestPrepareNetworkDuel(distance))
                throw new Error("No lethal target");
              if (tick < 48) first = 0x40 | steering;
              else if (duel && tick >= 115) first = 0x3;
              else if (detonate ? tick === 64 || tick === detonate : tick >= 64) first = 0x1;
            } else if (scenery) {
              if (tick > 0 && tick < 80) first = 0x2;
              else if (tick > 210) first = 0x40 | steering;
            } else if (!sceneryDamage && !triggerOnly) {
              if (tick === 60 && !Module._WebTestPlaceWeaponTarget(128))
                throw new Error("No target");
              if (tick === 110 && !Module._WebTestPlaceWeaponTarget(500))
                throw new Error("No target");
              if (tick < 56) {
                first = 0x40 | steering;
                second = 0x40 | (steering ^ 0xa000);
              } else {
                if (tick >= 64) first = 0x2 | (tick % 12 === 0 ? 0x1 : 0);
                if (tick >= 150) second = 0x40 | steering | 0x2;
              }
            }
            if (
              !Module._WebNetSetInput(tick, 0, first, 0, 0) ||
              !Module._WebNetSetInput(tick, 1, second, 0, 0) ||
              !Module._WebNetQueueTick(tick)
            )
              throw new Error("Simulation refused tick " + tick);
          };
          tm4Port.specialObjects = () =>
            classes.map((name) => {
              Module.ccall("WebTestSnapshotObjects", null, ["string"], [name]);
              return tm4Port.testSnapshotObjects;
            });
          tm4Port.canonical = () => {
            if (!Module._WebNetCaptureState())
              throw new Error(
                `Canonical capture refused at ${tm4Port.netMatch.tick}: ${tm4Port.netMatch.unsupported}`,
              );
            return btoa(String.fromCharCode(...tm4Port.netCapturedState));
          };
        },
        {
          shift,
          scenery,
          fall,
          sceneryDamage,
          triggerOnly,
          car,
          projectileTarget,
          duel,
          distance,
          detonate,
          radial,
          grab,
          classes,
          world,
          oil,
          neon,
          carnival,
        },
      );
      return page;
    };
    const source = await open(false);
    const destination = await open(true);

    const captured = await source.evaluate(
      ({
        scenery,
        extenders,
        checkpointTick,
        car,
        grab,
        oil,
        oilDestroyed,
        neon,
        carnival,
        triggers,
        fall,
        sceneryDamage,
      }) => {
        let contact = false;
        let helicopterStart;
        let coasterStart;
        if (scenery && !Module._WebTestAimAtDestroyable()) throw new Error("No destroyable");
        for (let tick = 0; tick < checkpointTick; tick++) {
          tm4Port.step(tick);
          contact ||= !!Module._WebTestNetworkCarContact();
          helicopterStart ??= tm4Port.helicopter?.position;
          coasterStart ??= tm4Port.coasterPosition;
        }
        if (
          grab &&
          (!Module._WebTestReadCarGrab() || !tm4Port.carGrab.holding || !tm4Port.carGrab.sound)
        )
          throw new Error("No live grab and loop at checkpoint");
        if (extenders && !Module._WebTestPortableExtenderFixture())
          throw new Error("Extender fixture refused");
        if (neon && (!tm4Port.trainPlayerHits || !tm4Port.ufoHolding || !tm4Port.ufoCapturedPlayer))
          throw new Error("Expected an actual train hit and held car");
        if (oilDestroyed) {
          Module.ccall("WebTestSnapshotObjects", null, ["string"], ["helicopter"]);
          if (tm4Port.helicopterRemoved !== 1 || tm4Port.testSnapshotObjects.length)
            throw new Error("Expected the helicopter to have been destroyed");
        }
        const start = performance.now();
        const size = Module._WebNetCapturePortableCheckpoint();
        if (!size) throw new Error("Capture refused: " + tm4Port.portableCheckpointError);
        if (
          (car || oil || neon || carnival || triggers.length || fall || sceneryDamage) &&
          !Module._WebNetCaptureLocalCheckpoint()
        )
          throw new Error("Local capture refused: " + tm4Port.localCheckpointError);
        return {
          size,
          captureMs: performance.now() - start,
          checkpoint: btoa(String.fromCharCode(...tm4Port.portableCheckpoint)),
          canonical: tm4Port.canonical(),
          car: Module._WebTestReplayCarAddress(),
          world: tm4Port.testPortableWorldAddress,
          live: tm4Port.specialObjects(),
          grab: grab ? tm4Port.carGrab : null,
          sections: tm4Port.netMatch.sections,
          contact,
          destroyed: scenery && !Module._WebTestDestroyablePresent(),
          coasterMoved:
            carnival &&
            tm4Port.coasterPosition?.some((value, index) => value !== coasterStart?.[index]),
          helicopterMoved:
            oil &&
            tm4Port.helicopter?.position.some((value, index) => value !== helicopterStart?.[index]),
          extenders: tm4Port.testPortableExtenders,
          targetHealth: tm4Port.testTargetHealth,
          frozen: Module._WebTestFrozenFaceTicks(1),
          damage: tm4Port.testTargetHealth - tm4Port.cars[1]?.health,
        };
      },
      {
        scenery,
        extenders,
        checkpointTick,
        car,
        grab,
        oil,
        oilDestroyed,
        neon,
        carnival,
        triggers,
        fall,
        sceneryDamage,
      },
    );
    if (frozenSnapshot) assert(captured.frozen > 0, "Expected live frozen model at capture");
    if (scenery) assert(captured.destroyed);
    else if (!fall && !sceneryDamage) {
      if (!neon && !triggerOnly)
        assert(
          oil ? captured.helicopterMoved : carnival ? captured.coasterMoved : captured.contact,
        );
      for (const [index, serials] of captured.live.entries())
        assert(serials.length, "No active " + classes[index] + " at tick " + checkpointTick);
    }
    const restored = await destination.evaluate(
      ({ checkpoint, extenders, grab }) => {
        const initial = tm4Port.canonical();
        const bytes = Uint8Array.from(atob(checkpoint), (c) => c.charCodeAt(0));
        tm4Port.portableCheckpoint = bytes.slice(0, -1);
        if (Module._WebNetBeginPortableReplay() || tm4Port.canonical() !== initial)
          throw new Error("Truncated snapshot changed initial state");
        tm4Port.portableCheckpoint = bytes.slice();
        tm4Port.portableCheckpoint[16] ^= 1;
        if (Module._WebNetBeginPortableReplay() || tm4Port.canonical() !== initial)
          throw new Error(
            "Corrupt checksum changed initial state: " + tm4Port.portableCheckpointError,
          );
        if (extenders) {
          const [sibling, foreignRoot] = extenders;
          const damaged = bytes.slice();
          const records = new DataView(damaged.buffer);
          // The snapshot prefix gives the session and world lengths. Object
          // entries have two sizes, then the header version, class name and serial.
          let offset = 36 + records.getUint32(8, true) + records.getUint32(12, true);
          while (offset < records.byteLength) {
            const header = records.getUint32(offset, true);
            const payload = records.getUint32(offset + 4, true);
            if (records.getUint32(offset + 8 + 68, true) + 1 === sibling) {
              // Extender payload starts with the descriptor version and its root handle.
              records.setUint32(offset + 8 + header + 1, foreignRoot, true);
              break;
            }
            offset += 8 + header + payload;
          }
          if (offset >= records.byteLength) throw new Error("Missing saved extender");
          tm4Port.portableCheckpoint = damaged;
          if (
            Module._WebNetBeginPortableReplay() ||
            tm4Port.portableCheckpointError !== "interaction extender ownership" ||
            tm4Port.canonical() !== initial
          )
            throw new Error("Cross-owner extender link was accepted or left changes");
        }
        if (tm4Port.netMatch.tick !== 0) throw new Error("Failed restore advanced the game");
        let published = 0;
        tm4Port.netMatchTick = () => published++;
        tm4Port.portableCheckpoint = bytes;
        const start = performance.now();
        if (!Module._WebNetBeginPortableReplay())
          throw new Error("Restore refused: " + tm4Port.portableCheckpointError);
        const restoreMs = performance.now() - start;
        Module._WebNetEndReplay();
        if (grab && !Module._WebTestReadCarGrab()) throw new Error("No restored grab");
        return {
          canonical: tm4Port.canonical(),
          sections: tm4Port.netMatch.sections,
          tick: tm4Port.netMatch.tick,
          car: Module._WebTestReplayCarAddress(),
          world: tm4Port.testPortableWorldAddress,
          live: tm4Port.specialObjects(),
          grab: grab ? tm4Port.carGrab : null,
          published,
          restoreMs,
          frozen: Module._WebTestFrozenFaceTicks(1),
        };
      },
      { checkpoint: captured.checkpoint, extenders: captured.extenders, grab },
    );
    assert.equal(restored.tick, checkpointTick);
    assert.equal(restored.published, 0);
    assert(restored.canonical === captured.canonical);
    assert.deepEqual(restored.sections, captured.sections);
    assert.deepEqual(restored.live, captured.live);
    assert.deepEqual(restored.grab, captured.grab);
    assert.equal(restored.frozen, captured.frozen);
    assert.notEqual(restored.car, captured.car);
    assert.notEqual(restored.world, captured.world);

    const run = (page) =>
      page.evaluate(
        ({
          checkpointTick,
          replayTicks,
          car,
          targetHealth,
          live,
          triggers,
          fall,
          sceneryDamage,
        }) => {
          const start = performance.now();
          const frames = [];
          const impacts = tm4Port.projectileImpacts ?? 0;
          const helicopters = tm4Port.helicopterRemoved ?? 0;
          const drops = tm4Port.ufoReleases ?? 0;
          const coasterHits = tm4Port.coasterPlayerHits ?? 0;
          const teleports = tm4Port.teleports ?? 0;
          const launches = tm4Port.playerJumppadLaunches ?? 0;
          let retired = false;
          let damage = 0;
          let frozen = Module._WebTestFrozenFaceTicks(1);
          for (let tick = checkpointTick; tick < checkpointTick + replayTicks; tick++) {
            const relativeTick = tick - checkpointTick;
            if (relativeTick === 2 && sceneryDamage) Module._WebTestDestroyMapScenery();
            if (relativeTick === 2 && triggers.includes("jumppad")) {
              if (!Module._WebTestApproachLevelTrigger(1, 1)) throw new Error("No map jumppad");
            }
            if (relativeTick === 55 && triggers.includes("teleporter")) {
              if (!Module._WebTestApproachLevelTrigger(0, 1)) throw new Error("No map teleporter");
            }
            tm4Port.step(tick);
            frozen = Math.max(frozen, Module._WebTestFrozenFaceTicks(1));
            if (car) {
              if (tick < 115) damage = Math.max(damage, targetHealth - tm4Port.cars[1].health);
              if (!retired) {
                const objects = tm4Port.specialObjects();
                retired = live.some((serials, index) =>
                  serials.some((serial) => !objects[index].includes(serial)),
                );
              }
            }
            frames.push({ canonical: tm4Port.canonical(), sections: tm4Port.netMatch.sections });
            if (fall && tm4Port.netMatch.roundFinished) break;
          }
          return {
            frames,
            frozen,
            frozenAtEnd: Module._WebTestFrozenFaceTicks(1),
            impacts: (tm4Port.projectileImpacts ?? 0) - impacts,
            retired,
            damage,
            helicopters: (tm4Port.helicopterRemoved ?? 0) - helicopters,
            drops: (tm4Port.ufoReleases ?? 0) - drops,
            coasterHits: (tm4Port.coasterPlayerHits ?? 0) - coasterHits,
            teleports: (tm4Port.teleports ?? 0) - teleports,
            launches: (tm4Port.playerJumppadLaunches ?? 0) - launches,
            replayMs: performance.now() - start,
            death: (car || fall) && tm4Port.netMatch.roundFinished,
            winner: tm4Port.netMatch.winner,
            sceneryDestroyed:
              sceneryDamage && tm4Port.testSceneryDamaged && !Module._WebTestDestroyablePresent(),
          };
        },
        {
          checkpointTick,
          replayTicks,
          car,
          targetHealth: captured.targetHealth,
          live: captured.live,
          triggers,
          fall,
          sceneryDamage,
        },
      );
    const [expected, actual] = await Promise.all([run(source), run(destination)]);
    if (fall) {
      assert(expected.frames.length >= 30);
      assert(expected.death && actual.death);
      assert.equal(actual.winner, 1);
      assert.equal(actual.impacts, 0);
    } else assert.equal(expected.frames.length, replayTicks);
    if (
      !fall &&
      !scenery &&
      !car &&
      !oilDestroyed &&
      !neon &&
      !carnival &&
      !sceneryDamage &&
      !triggerOnly
    )
      assert(expected.impacts > 0);
    assert.equal(actual.impacts, expected.impacts);
    if (projectileTarget) assert(actual.frozen > 0, "Expected the projectile to freeze its target");
    if (frozenSnapshot)
      assert.equal(actual.frozenAtEnd, 0, "Expected thaw to release copied faces");
    assert.equal(actual.frozen, expected.frozen);
    if (sceneryDamage) assert(actual.sceneryDestroyed && expected.sceneryDestroyed);
    const compare = (frames) => {
      assert.equal(frames.length, expected.frames.length);
      for (const [index, frame] of frames.entries()) {
        const tick = index + checkpointTick + 1;
        assert.deepEqual(frame.sections, expected.frames[index].sections, "Subsystems at " + tick);
        assert(frame.canonical === expected.frames[index].canonical, "Canonical bytes at " + tick);
      }
    };
    compare(actual.frames);
    if (oil) {
      assert.equal(actual.helicopters, oilDestroyed ? 0 : 1);
      assert.equal(expected.helicopters, oilDestroyed ? 0 : 1);
    }
    if (car) {
      assert(actual.damage > 0, "Expected nonlethal damage from the special");
      assert.equal(actual.damage, expected.damage);
      assert(actual.retired && expected.retired, "Expected a captured object to expire");
      if (deathTest !== "0")
        assert(expected.death && actual.death, "Expected a lethal hit during replay");
    }
    if (neon) {
      assert.equal(expected.drops, 1);
      assert.equal(actual.drops, 1);
    }
    if (carnival) {
      assert(expected.coasterHits > 0);
      assert.equal(actual.coasterHits, expected.coasterHits);
    }
    if (triggers.includes("teleporter")) assert(expected.teleports > 0);
    if (triggers.includes("jumppad")) assert(expected.launches > 0);
    assert.equal(actual.teleports, expected.teleports);
    assert.equal(actual.launches, expected.launches);
    if (car || oil || neon || carnival || triggers.length || fall || sceneryDamage) {
      const local = await source.evaluate(() => {
        if (!Module._WebNetRestoreLocalCheckpoint())
          throw new Error("Local restore refused: " + tm4Port.localCheckpointError);
        return { canonical: tm4Port.canonical(), car: Module._WebTestReplayCarAddress() };
      });
      assert(local.canonical === captured.canonical);
      assert.equal(local.car, captured.car);
      const replayed = await run(source);
      compare(replayed.frames);
      if (oil) assert.equal(replayed.helicopters, oilDestroyed ? 0 : 1);
      else if (neon) assert.equal(replayed.drops, 1);
      else if (carnival) assert.equal(replayed.coasterHits, expected.coasterHits);
      else if ((car && deathTest !== "0") || fall) assert(replayed.death);
      if (sceneryDamage) assert(replayed.sceneryDestroyed);
      assert.equal(replayed.frozen, expected.frozen);
      assert.equal(replayed.teleports, expected.teleports);
      assert.equal(replayed.launches, expected.launches);
      assert(await source.evaluate(() => Module._WebNetFinishLocalReplay()));
    }
    for (const page of [source, destination]) {
      await page.evaluate((world) => {
        Module._WebTestPortableWorldClose();
        Module._WebNetCancelMatch();
        const index = Module.ccall("WebNetWorldIndex", "number", ["string"], [world]);
        if (!Module._WebNetRequestMatch(2, index, 12345, -1)) throw new Error("Restart refused");
        Module._WebNetCancelMatch();
      }, world);
    }
    assert.deepEqual(errors, []);
    console.log("PASS independent portable checkpoint", {
      car: car ?? "Orbital",
      world,
      helicopters: actual.helicopters,
      ufoDrops: actual.drops,
      coasterHits: actual.coasterHits,
      teleports: actual.teleports,
      launches: actual.launches,
      frozen: actual.frozen,
      specialDamage: Math.max(captured.damage || 0, actual.damage),
      death: actual.death,
      impacts: actual.impacts,
      activeClasses: classes,
      size: captured.size,
      tick: restored.tick,
      captureMs: captured.captureMs,
      restoreMs: restored.restoreMs,
      replayTicks: actual.frames.length,
      replayMs: actual.replayMs,
    });
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
