/* global Module, tm4Port */
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";

const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
const browser = await launchBrowser();
try {
  const errors = [];
  const open = async (shift) => {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    if (shift)
      await page.addInitScript(() => {
        globalThis.tm4TestShiftResourceHeap = true;
      });
    await page.goto(new URL("?simulation-reference=1&checkpoint=1", site).href);
    await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
      timeout: 60_000,
    });
    const initial = await page.evaluate((shift) => {
      if (shift && !Module._malloc(shift)) throw new Error("Could not shift simulation allocator");
      if (
        !Module.ccall(
          "WebNetStartMatch",
          "number",
          ["number", "number", "number", "number", "number", "number", "string", "string"],
          [2, 3, 0, 12345, -1, 0, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
        )
      )
        throw new Error("Match refused");
      if (!Module._WebTestPortableWorldOpen()) throw new Error("World layout refused");
      if (!Module._WebTestAimAtDestroyable()) throw new Error("Missing destroyable");
      return {
        car: Module._WebTestReplayCarAddress(),
        world: tm4Port.testPortableWorldAddress,
        geometry: tm4Port.testDestroyable,
        bytes: Module._WebTestPortableWorldCapture(),
      };
    }, shift);
    assert.equal(initial.bytes, 16);
    assert(initial.geometry.enabledFaces && initial.geometry.collisionEnabled);
    return { page, initial };
  };
  const source = await open(0);
  const destination = await open(2 * 1024 * 1024);
  assert.notEqual(source.initial.car, destination.initial.car, "simulation arenas must differ");
  assert.notEqual(
    source.initial.world,
    destination.initial.world,
    "local map addresses must differ",
  );
  const saved = await source.page.evaluate(() => {
    const step = (tick, buttons) => {
      if (
        !Module._WebNetSetInput(tick, 0, buttons, 0, 0) ||
        !Module._WebNetSetInput(tick, 1, 0, 0, 0) ||
        !Module._WebNetQueueTick(tick)
      )
        throw new Error("Simulation refused tick " + tick);
    };
    step(0, 0);
    for (let tick = 1; tick <= 180; tick++) step(tick, 0x2);
    if (Module._WebTestDestroyablePresent()) throw new Error("Scenery survived");
    const size = Module._WebTestPortableWorldCapture();
    return { size, bytes: [...tm4Port.testPortableWorld], geometry: tm4Port.testDestroyable };
  });
  assert(saved.size > 16 && saved.size < 4096, "compact scenery delta");
  assert.equal(saved.geometry.enabledFaces, 0);
  assert.equal(saved.geometry.collisionEnabled, 0);
  assert.equal(saved.geometry.collisionOwned, 0);
  const restored = await destination.page.evaluate((bytes) => {
    const restore = (data) => {
      tm4Port.testPortableWorld = new Uint8Array(data);
      const result = Module._WebTestPortableWorldRestore();
      Module._WebTestDestroyablePresent();
      return { result, geometry: tm4Port.testDestroyable };
    };
    const badIndex = [...bytes];
    badIndex.fill(255, 16, 20);
    const badVersion = [...bytes];
    badVersion[0]++;
    const rejected = [bytes.slice(0, -1), badIndex, badVersion].map(restore);
    const accepted = restore(bytes);
    if (!Module._WebTestPortableWorldCapture()) throw new Error("Round-trip capture refused");
    return { rejected, accepted, recaptured: [...tm4Port.testPortableWorld] };
  }, saved.bytes);
  for (const rejection of restored.rejected) {
    assert.equal(rejection.result, 0);
    assert.deepEqual(rejection.geometry, destination.initial.geometry);
  }
  assert.equal(restored.accepted.result, 1);
  const { enabledFaces, collisionEnabled, collisionOwned } = saved.geometry;
  assert.deepEqual(
    [
      restored.accepted.geometry.enabledFaces,
      restored.accepted.geometry.collisionEnabled,
      restored.accepted.geometry.collisionOwned,
    ],
    [enabledFaces, collisionEnabled, collisionOwned],
  );
  assert.deepEqual(restored.recaptured, saved.bytes);
  for (const { page } of [source, destination])
    await page.evaluate(() => Module._WebTestPortableWorldClose());
  assert.deepEqual(errors, []);
  console.log("PASS portable scenery section", saved.size, "bytes");
} finally {
  await browser.close();
}
