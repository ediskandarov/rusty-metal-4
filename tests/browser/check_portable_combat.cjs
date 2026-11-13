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
    const open = async (shift) => {
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(new URL("?simulation-reference=1&checkpoint=1", site).href);
      await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
        timeout: 60_000,
      });
      const initial = await page.evaluate((shift) => {
        if (shift && !Module._malloc(shift)) throw new Error("Could not shift allocator");
        if (
          !Module.ccall(
            "WebNetStartMatch",
            "number",
            ["number", "number", "number", "number", "number", "number", "string", "string"],
            [2, 3, 0, 12345, -1, 0, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
          )
        )
          throw new Error("Match refused");
        tm4Port.step = (tick) => {
          if (tick === 60 && !Module._WebTestPlaceWeaponTarget(128)) throw new Error("No target");
          if (tick === 110 && !Module._WebTestPlaceWeaponTarget(500)) throw new Error("No target");
          const steering = tick % 64 < 32 ? 0x8000 : 0x2000;
          const first =
            tick < 56 ? 0x40 | steering : tick >= 64 ? 0x2 | (tick % 12 === 0 ? 0x1 : 0) : 0;
          const second =
            tick < 56 ? 0x40 | (steering ^ 0xa000) : tick >= 150 ? 0x40 | steering | 0x2 : 0;
          if (
            !Module._WebNetSetInput(tick, 0, first, 0, 0) ||
            !Module._WebNetSetInput(tick, 1, second, 0, 0) ||
            !Module._WebNetQueueTick(tick)
          )
            throw new Error("Simulation refused tick " + tick);
        };
        for (let tick = 0; tick < 80; tick++) tm4Port.step(tick);
        if (!Module._WebTestPortableProjectileCapture())
          throw new Error("No supported live projectile at checkpoint");
        const { bytes, header, projectile, owner, target } = tm4Port.testPortableProjectile;
        Module._WebTestLocalCheckpointProjectiles();
        const sounds = [0, 1].map((loop) => {
          if (!Module._WebTestPortableSoundCapture(loop))
            throw new Error("No finite or looping emitter at checkpoint");
          return {
            bytes: [...tm4Port.testPortableSound.bytes],
            allocation: tm4Port.testPortableSound.allocation,
          };
        });
        const cars = [0, 1].map((slot) => {
          if (!Module._WebTestPortableCarCapture(slot))
            throw new Error("Unsupported car record " + slot);
          return [...tm4Port.testPortableCar];
        });
        if (!Module._WebTestPortableSessionCapture()) throw new Error("Session record refused");
        return {
          session: [...tm4Port.testPortableSession],
          cars,
          bytes: [...bytes],
          header: [...header],
          projectile,
          owner,
          target,
          sounds,
          serial: tm4Port.testLiveProjectiles[0],
          digest: tm4Port.netMatch.digest,
        };
      }, shift);
      return { page, initial };
    };
    const source = await open(0);
    const destination = await open(2 * 1024 * 1024);
    assert.notEqual(source.initial.projectile, destination.initial.projectile);
    assert.notEqual(source.initial.owner, destination.initial.owner);
    assert.deepEqual(source.initial.bytes, destination.initial.bytes);
    assert.deepEqual(source.initial.header, destination.initial.header);
    assert.equal(source.initial.digest, destination.initial.digest);

    const restored = await destination.page.evaluate(({ bytes, header }) => {
      const canonical = () => {
        if (!Module._WebNetCaptureState()) throw new Error("Canonical capture refused");
        return [...tm4Port.netCapturedState];
      };
      const initial = canonical();
      if (!Module._WebTestPortableProjectilePerturb()) throw new Error("Perturbation refused");
      const changed = canonical();
      const restore = (data, shape = header) => {
        tm4Port.testPortableProjectile = {
          bytes: new Uint8Array(data),
          header: new Uint8Array(shape),
        };
        return Module._WebTestPortableProjectileRestore();
      };
      const invalid = [...bytes];
      invalid[0] ^= 255;
      if (restore(bytes.slice(0, -1)) || restore(invalid) || restore(bytes, header.slice(0, -1)))
        throw new Error("Malformed record accepted");
      const afterRejection = canonical();
      if (!restore(bytes) || !Module._WebTestPortableProjectileCapture())
        throw new Error("Projectile restore refused");
      return {
        initial,
        changed,
        afterRejection,
        restored: canonical(),
        bytes: [...tm4Port.testPortableProjectile.bytes],
        header: [...tm4Port.testPortableProjectile.header],
        projectile: tm4Port.testPortableProjectile.projectile,
      };
    }, source.initial);
    assert.notDeepEqual(restored.changed, restored.initial);
    assert.deepEqual(restored.afterRejection, restored.changed);
    assert.deepEqual(restored.restored, restored.initial);
    assert.deepEqual(restored.bytes, source.initial.bytes);
    assert.deepEqual(restored.header, source.initial.header);
    assert.notEqual(restored.projectile, destination.initial.projectile);

    for (const loop of [0, 1]) {
      const sound = source.initial.sounds[loop];
      assert.notEqual(sound.allocation, destination.initial.sounds[loop].allocation);
      assert.deepEqual(sound.bytes, destination.initial.sounds[loop].bytes);
      const result = await destination.page.evaluate(
        ({ loop, bytes }) => {
          const canonical = () => {
            if (!Module._WebNetCaptureState()) throw new Error("Canonical capture refused");
            return [...tm4Port.netCapturedState];
          };
          const initial = canonical();
          if (!Module._WebTestPortableSoundPerturb(loop))
            throw new Error("Emitter perturbation refused");
          const changed = canonical();
          const restore = (data) => {
            tm4Port.testPortableSound = { bytes: new Uint8Array(data) };
            return Module._WebTestPortableSoundRestore(loop);
          };
          const invalid = [...bytes];
          invalid[0] ^= 255;
          if (restore(bytes.slice(0, -1)) || restore(invalid))
            throw new Error("Malformed sound record accepted");
          const afterRejection = canonical();
          if (!restore(bytes) || !Module._WebTestPortableSoundCapture(loop))
            throw new Error("Emitter restore refused for loop=" + loop);
          return {
            initial,
            changed,
            afterRejection,
            restored: canonical(),
            bytes: [...tm4Port.testPortableSound.bytes],
          };
        },
        { loop, bytes: sound.bytes },
      );
      assert.notDeepEqual(result.changed, result.initial);
      assert.deepEqual(result.afterRejection, result.changed);
      assert.deepEqual(result.restored, result.initial);
      assert.deepEqual(result.bytes, sound.bytes);
    }

    for (const slot of [0, 1]) {
      const bytes = source.initial.cars[slot];
      assert.deepEqual(bytes, destination.initial.cars[slot]);
      const result = await destination.page.evaluate(
        ({ slot, bytes }) => {
          const canonical = () => {
            if (!Module._WebNetCaptureState()) throw new Error("Canonical capture refused");
            return [...tm4Port.netCapturedState];
          };
          const initial = canonical();
          if (!Module._WebTestPortableCarPerturb(slot)) throw new Error("Car perturbation refused");
          const changed = canonical();
          tm4Port.testPortableCar = new Uint8Array(bytes.slice(0, -1));
          if (Module._WebTestPortableCarRestore(slot))
            throw new Error("Malformed car record accepted");
          const afterRejection = canonical();
          tm4Port.testPortableCar = new Uint8Array(bytes);
          if (!Module._WebTestPortableCarRestore(slot) || !Module._WebTestPortableCarCapture(slot))
            throw new Error("Car restore refused for slot " + slot);
          return {
            initial,
            changed,
            afterRejection,
            restored: canonical(),
            bytes: [...tm4Port.testPortableCar],
          };
        },
        { slot, bytes },
      );
      assert.notDeepEqual(result.changed, result.initial);
      assert.deepEqual(result.afterRejection, result.changed);
      assert.deepEqual(result.restored, result.initial);
      assert.deepEqual(result.bytes, bytes);
    }

    const session = await destination.page.evaluate((bytes) => {
      const canonical = () => {
        if (!Module._WebNetCaptureState()) throw new Error("Canonical capture refused");
        return [...tm4Port.netCapturedState];
      };
      const initial = canonical();
      if (!Module._WebTestPortableSessionPerturb()) throw new Error("Session perturbation refused");
      const changed = canonical();
      tm4Port.testPortableSession = new Uint8Array(bytes.slice(0, -1));
      if (Module._WebTestPortableSessionRestore())
        throw new Error("Malformed session record accepted");
      const afterRejection = canonical();
      tm4Port.testPortableSession = new Uint8Array(bytes);
      if (!Module._WebTestPortableSessionRestore() || !Module._WebTestPortableSessionCapture())
        throw new Error("Session root restore refused");
      return {
        initial,
        changed,
        afterRejection,
        restored: canonical(),
        bytes: [...tm4Port.testPortableSession],
      };
    }, source.initial.session);
    assert.notDeepEqual(session.changed, session.initial);
    assert.deepEqual(session.afterRejection, session.changed);
    assert.deepEqual(session.restored, session.initial);
    assert.deepEqual(session.bytes, source.initial.session);

    const run = ({ page }) =>
      page.evaluate(() => {
        const frames = [];
        const impacts = tm4Port.projectileImpacts ?? 0;
        for (let tick = 80; tick < 220; tick++) {
          tm4Port.step(tick);
          if (!Module._WebNetCaptureState()) throw new Error("Canonical capture refused");
          frames.push({
            state: tm4Port.netMatch.sections,
            bytes: btoa(String.fromCharCode(...tm4Port.netCapturedState)),
          });
        }
        Module._WebTestLocalCheckpointProjectiles();
        return {
          frames,
          impacts: (tm4Port.projectileImpacts ?? 0) - impacts,
          surviving: tm4Port.testLiveProjectiles,
        };
      });
    const [expected, actual] = await Promise.all([run(source), run(destination)]);
    assert.equal(expected.frames.length, 140);
    assert(expected.impacts > 0);
    assert.equal(actual.impacts, expected.impacts);
    assert.deepEqual(actual.surviving, expected.surviving);
    assert(!actual.surviving.includes(source.initial.serial));
    assert.equal(actual.frames.length, expected.frames.length);
    for (let frame = 0; frame < expected.frames.length; frame++) {
      assert.deepEqual(
        actual.frames[frame].state,
        expected.frames[frame].state,
        "Subsystems at " + (81 + frame),
      );
      assert(
        actual.frames[frame].bytes === expected.frames[frame].bytes,
        "Canonical bytes at " + (81 + frame),
      );
    }
    for (const { page } of [source, destination]) {
      await page.evaluate(() => {
        Module._WebNetCancelMatch();
        if (
          !Module.ccall(
            "WebNetStartMatch",
            "number",
            ["number", "number", "number", "number", "number", "number", "string", "string"],
            [2, 3, 0, 12345, -1, 0, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
          )
        )
          throw new Error("Restart refused");
        Module._WebNetCancelMatch();
      });
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS portable session, car, projectile and sound records",
      source.initial.bytes.length,
      "bytes and",
      actual.frames.length,
      "equal subsequent ticks",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
