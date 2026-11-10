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
    const extenders = process.env.TM4_PORTABLE_EXTENDERS === "1";
    const checkpointTick = scenery ? 210 : 80;
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
        ({ shift, scenery }) => {
          if (shift && !Module._malloc(2 * 1024 * 1024))
            throw new Error("Simulation arena shift refused");
          if (
            !Module._WebNetEnablePortableCheckpoint() ||
            !Module._WebNetRequestMatch(2, 0, 12345, -1)
          )
            throw new Error("Match refused");
          tm4Port.step = (tick) => {
            if (!scenery && tick === 60 && !Module._WebTestPlaceWeaponTarget(128))
              throw new Error("No target");
            if (!scenery && tick === 110 && !Module._WebTestPlaceWeaponTarget(500))
              throw new Error("No target");
            const steering = tick % 64 < 32 ? 0x8000 : 0x2000;
            const first = scenery
              ? tick > 0 && tick < 80
                ? 0x2
                : tick > 210
                  ? 0x40 | steering
                  : 0
              : tick < 56
                ? 0x40 | steering
                : tick >= 64
                  ? 0x2 | (tick % 12 === 0 ? 0x1 : 0)
                  : 0;
            const second = scenery
              ? 0
              : tick < 56
                ? 0x40 | (steering ^ 0xa000)
                : tick >= 150
                  ? 0x40 | steering | 0x2
                  : 0;
            if (
              !Module._WebNetSetInput(tick, 0, first, 0, 0) ||
              !Module._WebNetSetInput(tick, 1, second, 0, 0) ||
              !Module._WebNetQueueTick(tick)
            )
              throw new Error("Simulation refused tick " + tick);
          };
          tm4Port.canonical = () => {
            if (!Module._WebNetCaptureState()) throw new Error("Canonical capture refused");
            return btoa(String.fromCharCode(...tm4Port.netCapturedState));
          };
        },
        { shift, scenery },
      );
      return page;
    };
    const source = await open(false);
    const destination = await open(true);

    const captured = await source.evaluate(
      ({ scenery, extenders, checkpointTick }) => {
        let contact = false;
        if (scenery && !Module._WebTestAimAtDestroyable()) throw new Error("No destroyable");
        for (let tick = 0; tick < checkpointTick; tick++) {
          tm4Port.step(tick);
          contact ||= !!Module._WebTestNetworkCarContact();
        }
        Module._WebTestLocalCheckpointProjectiles();
        if (extenders && !Module._WebTestPortableExtenderFixture())
          throw new Error("Extender fixture refused");
        const start = performance.now();
        const size = Module._WebNetCapturePortableCheckpoint();
        if (!size) throw new Error("Capture refused: " + tm4Port.portableCheckpointError);
        return {
          size,
          captureMs: performance.now() - start,
          checkpoint: btoa(String.fromCharCode(...tm4Port.portableCheckpoint)),
          canonical: tm4Port.canonical(),
          car: Module._WebTestReplayCarAddress(),
          world: tm4Port.testPortableWorldAddress,
          live: tm4Port.testLiveProjectiles,
          sections: tm4Port.netMatch.sections,
          contact,
          destroyed: scenery && !Module._WebTestDestroyablePresent(),
          extenders: tm4Port.testPortableExtenders,
        };
      },
      { scenery, extenders, checkpointTick },
    );
    if (scenery) assert(captured.destroyed);
    else assert(captured.live.length && captured.contact);
    const restored = await destination.evaluate(
      ({ checkpoint, extenders }) => {
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
        Module._WebTestLocalCheckpointProjectiles();
        return {
          canonical: tm4Port.canonical(),
          sections: tm4Port.netMatch.sections,
          tick: tm4Port.netMatch.tick,
          car: Module._WebTestReplayCarAddress(),
          world: tm4Port.testPortableWorldAddress,
          live: tm4Port.testLiveProjectiles,
          published,
          restoreMs,
        };
      },
      { checkpoint: captured.checkpoint, extenders: captured.extenders },
    );
    assert.equal(restored.tick, checkpointTick);
    assert.equal(restored.published, 0);
    assert(restored.canonical === captured.canonical);
    assert.deepEqual(restored.sections, captured.sections);
    assert.deepEqual(restored.live, captured.live);
    assert.notEqual(restored.car, captured.car);
    assert.notEqual(restored.world, captured.world);

    const run = (page) =>
      page.evaluate((checkpointTick) => {
        const start = performance.now();
        const frames = [];
        const impacts = tm4Port.projectileImpacts ?? 0;
        for (let tick = checkpointTick; tick < checkpointTick + 140; tick++) {
          tm4Port.step(tick);
          frames.push({ canonical: tm4Port.canonical(), sections: tm4Port.netMatch.sections });
        }
        return {
          frames,
          impacts: (tm4Port.projectileImpacts ?? 0) - impacts,
          replayMs: performance.now() - start,
        };
      }, checkpointTick);
    const [expected, actual] = await Promise.all([run(source), run(destination)]);
    assert.equal(expected.frames.length, 140);
    if (!scenery) assert(expected.impacts > 0);
    assert.equal(actual.impacts, expected.impacts);
    for (let i = 0; i < expected.frames.length; i++) {
      const tick = i + checkpointTick + 1;
      assert.deepEqual(
        actual.frames[i].sections,
        expected.frames[i].sections,
        "Subsystems at " + tick,
      );
      assert(
        actual.frames[i].canonical === expected.frames[i].canonical,
        "Canonical bytes at " + tick,
      );
    }
    for (const page of [source, destination]) {
      await page.evaluate(() => {
        Module._WebTestPortableWorldClose();
        Module._WebNetCancelMatch();
        if (!Module._WebNetRequestMatch(2, 0, 12345, -1)) throw new Error("Restart refused");
        Module._WebNetCancelMatch();
      });
    }
    assert.deepEqual(errors, []);
    console.log("PASS independent portable checkpoint", {
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
