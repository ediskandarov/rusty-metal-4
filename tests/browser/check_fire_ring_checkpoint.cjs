/* global Module, tm4Port */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

// The terrain case uses the same ignition entry point as Oil Rig weapon impacts.
// The radial case also covers the non-terrain lifetime and a >4 KiB particle payload.
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: ["--enable-unsafe-swiftshader"],
  });
  const errors = [];
  const open = async (shift, terrain) => {
    const page = await browser.newPage();
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error.message);
    });
    if (shift)
      await page.addInitScript(() => {
        globalThis.tm4TestShiftResourceHeap = true;
      });
    await page.goto(
      new URL(
        "?simulation-reference=1&checkpoint=1",
        process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/",
      ).href,
    );
    await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 60000 });
    await page.evaluate(
      ({ shift, terrain }) => {
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        if (shift) check(Module._malloc(2 * 1024 * 1024), "arena shift failed");
        const world = Module.ccall("WebNetWorldIndex", "number", ["string"], ["The Oil Rig"]);
        check(
          Module.ccall(
            "WebNetStartMatch",
            "number",
            ["number", "number", "number", "number", "number", "number", "string", "string"],
            [
              8,
              255,
              world,
              12345,
              -1,
              1,
              ["Orbital", "Pizza Boy", ...Array(6).fill("Orbital")].join("\n"),
              "0000000000000001\n0000000000000002\n0000000000000003\n0000000000000004\n0000000000000005\n0000000000000006\n0000000000000007\n0000000000000008",
            ],
          ),
          "match start failed",
        );
        tm4Port.rings = () => {
          Module._WebTestReadFireRings();
          return tm4Port.testFireRings;
        };
        tm4Port.canonical = () => {
          check(
            Module._WebNetCaptureState(),
            "canonical capture failed: " + tm4Port.netMatch.unsupported,
          );
          return btoa(String.fromCharCode(...tm4Port.netCapturedState));
        };
        tm4Port.frame = () => ({
          canonical: tm4Port.canonical(),
          rings: tm4Port
            .rings()
            .map(({ serial, particleCount, divisions, radius, polygonIndex, animations }) => ({
              serial,
              particleCount,
              divisions,
              radius,
              polygonIndex,
              animations: animations.map(({ serial, owned }) => ({ serial, owned })),
            })),
        });
        tm4Port.noOrphanAnimations = (frames) => {
          const children = new Set(
            frames.flatMap((frame) =>
              frame.rings.flatMap((ring) => ring.animations.map((animation) => animation.serial)),
            ),
          );
          Module.ccall("WebTestSnapshotObjects", null, ["string"], ["anim"]);
          check(
            !tm4Port.testSnapshotObjects.some((serial) => children.has(serial)),
            "expired ring left live animation children",
          );
        };
        tm4Port.step = (tick) => {
          if (tick === 50) check(Module._WebTestCreateFireRing(+terrain), "ignition failed");
          for (let slot = 0; slot < 8; ++slot)
            check(Module._WebNetSetInput(tick, slot, 0, 0, 0), "input failed");
          check(Module._WebNetQueueTick(tick), "tick failed " + tick);
        };
      },
      { shift, terrain },
    );
    return page;
  };
  try {
    for (const terrain of [true, false]) {
      const source = await open(false, terrain);
      const captured = await source.evaluate(() => {
        for (let tick = 0; tick < 50; ++tick) tm4Port.step(tick);
        const before = tm4Port.frame();
        if (!Module._WebNetCaptureLocalCheckpoint()) throw new Error("pre-ignition capture failed");
        let published = 0;
        tm4Port.testSimulationTick = () => published++;
        const frames = [],
          snapshots = [];
        for (let tick = 50; tick < 350; ++tick) {
          tm4Port.step(tick);
          const frame = tm4Port.frame();
          frames.push(frame);
          if (
            tick === 50 ||
            tick === 55 ||
            (!snapshots[2] && frame.rings[0]?.particleCount > 110)
          ) {
            if (!Module._WebNetCapturePortableCheckpoint())
              throw new Error("portable capture failed: " + tm4Port.portableCheckpointError);
            snapshots.push({
              tick: tick + 1,
              frame,
              rings: tm4Port.rings(),
              bytes: btoa(String.fromCharCode(...tm4Port.portableCheckpoint)),
            });
          }
        }
        if (published !== frames.length) throw new Error("live publication count differs");
        for (let repeat = 0; repeat < 3; ++repeat) {
          if (!Module._WebNetRestoreLocalCheckpoint()) throw new Error("local restore failed");
          if (JSON.stringify(tm4Port.frame()) !== JSON.stringify(before))
            throw new Error("pre-ignition restore differs");
          for (let tick = 50; tick < 350; ++tick) {
            tm4Port.step(tick);
            if (JSON.stringify(tm4Port.frame()) !== JSON.stringify(frames[tick - 50]))
              throw new Error("local replay differs at " + tick);
          }
          if (published !== frames.length) throw new Error("replay published external ticks");
          if (Module._WebTestNetworkPlaybackVoices())
            throw new Error("replay started audio voices");
          if (!Module._WebNetFinishLocalReplay()) throw new Error("local replay finish failed");
        }
        tm4Port.noOrphanAnimations(frames);
        if (!Module._WebNetRestoreLocalCheckpoint()) throw new Error("pre-ignition restore failed");
        for (let tick = 50; tick < 56; ++tick) tm4Port.step(tick);
        if (!Module._WebNetFinishLocalReplay()) throw new Error("active fixture replay failed");
        const active = tm4Port.frame(),
          addresses = tm4Port.rings();
        if (!Module._WebNetCaptureLocalCheckpoint()) throw new Error("active-ring capture failed");
        for (let repeat = 0; repeat < 3; ++repeat) {
          if (repeat) {
            if (!Module._WebNetRestoreLocalCheckpoint())
              throw new Error("active-ring restore failed");
            if (
              JSON.stringify(tm4Port.frame()) !== JSON.stringify(active) ||
              JSON.stringify(tm4Port.rings()) !== JSON.stringify(addresses)
            )
              throw new Error("active ring allocations/graph were not restored");
          }
          const notifications = published;
          for (let tick = 56; tick < 350; ++tick) {
            tm4Port.step(tick);
            if (JSON.stringify(tm4Port.frame()) !== JSON.stringify(frames[tick - 50]))
              throw new Error("active-ring replay differs at " + tick);
          }
          tm4Port.noOrphanAnimations(frames);
          if (repeat && (published !== notifications || Module._WebTestNetworkPlaybackVoices()))
            throw new Error("active-ring replay reached presentation");
          if (repeat && !Module._WebNetFinishLocalReplay())
            throw new Error("active replay finish failed");
        }
        if (!Module._WebNetCaptureLocalCheckpoint())
          throw new Error("post-replay arena capture failed");
        return { frames, snapshots, published };
      });
      assert(captured.frames[0].rings.length, "No active ring after ignition");
      assert.equal(captured.frames[0].rings[0].particleCount, 3);
      assert(
        captured.frames.some(({ rings }) => rings[0]?.particleCount > 3),
        "No subdivision",
      );
      assert.equal(captured.frames.at(-1).rings.length, 0, "Ring did not expire");
      for (const frame of captured.frames)
        for (const ring of frame.rings) {
          assert.equal(ring.animations.length, ring.particleCount);
          assert(
            ring.animations.every(({ serial, owned }) => serial >= 0 && owned),
            "Broken child ownership",
          );
          assert.equal(ring.polygonIndex > 0, terrain, "Broken terrain binding");
        }
      if (!terrain) assert(captured.snapshots.length >= 3, "No large particle-array checkpoint");
      for (const saved of captured.snapshots) {
        const destination = await open(true, terrain);
        const restored = await destination.evaluate(
          ({ saved, frames }) => {
            tm4Port.portableCheckpoint = Uint8Array.from(atob(saved.bytes), (c) => c.charCodeAt(0));
            let published = 0;
            tm4Port.testSimulationTick = () => published++;
            if (!Module._WebNetBeginPortableReplay())
              throw new Error("portable restore failed: " + tm4Port.portableCheckpointError);
            const rings = tm4Port.rings();
            if (JSON.stringify(tm4Port.frame()) !== JSON.stringify(saved.frame))
              throw new Error("portable graph/canonical state differs");
            for (let tick = saved.tick; tick < 350; ++tick) {
              tm4Port.step(tick);
              if (JSON.stringify(tm4Port.frame()) !== JSON.stringify(frames[tick - 50]))
                throw new Error("portable replay differs at " + tick);
            }
            if (published || Module._WebTestNetworkPlaybackVoices())
              throw new Error("portable replay reached presentation");
            tm4Port.noOrphanAnimations(frames);
            Module._WebNetEndReplay();
            if (!Module._WebNetCaptureLocalCheckpoint())
              throw new Error("post-expiry arena capture failed");
            Module._WebNetCancelMatch();
            return rings;
          },
          { saved, frames: captured.frames },
        );
        assert.notEqual(restored[0].address, saved.rings[0].address);
        assert.notEqual(restored[0].nameAddress, saved.rings[0].nameAddress);
        assert.notEqual(restored[0].particlesAddress, saved.rings[0].particlesAddress);
        if (terrain) assert.notEqual(restored[0].polygonAddress, saved.rings[0].polygonAddress);
        assert.notEqual(restored[0].animations[0].address, saved.rings[0].animations[0].address);
        await destination.close();
      }
      await source.close();
      console.log("PASS eight-player Oil Rig fireRing", {
        terrain,
        snapshots: captured.snapshots.map((s) => s.tick),
        peakParticles: Math.max(
          ...captured.frames.flatMap((f) => f.rings.map((r) => r.particleCount)),
        ),
        replayTicks: captured.frames.length,
        localReplays: 5,
      });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
