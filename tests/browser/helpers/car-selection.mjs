/* global Module, tm4Port */
import assert from "node:assert/strict";

import { closeSettings } from "./player.mjs";

async function press(page, frame, key) {
  await page.keyboard.press(key, { delay: 150 });
  // Sample key-up before another press. Done can also leave the menu immediately
  // for late admission, after which its frame counter no longer advances.
  const released = await frame.evaluate(() => tm4Port.frames);
  await frame.waitForFunction(
    (value) => !tm4Port.menuReady || tm4Port.frames >= value + 2,
    released,
  );
}

export async function previewCar(page, car) {
  await page.bringToFront();
  const frame = await (await page.locator("#room-player").elementHandle()).contentFrame();
  await frame.waitForFunction(
    () => globalThis.tm4Port?.screen === "carsel" && tm4Port.menuReady,
    null,
    { timeout: 120000 },
  );
  await closeSettings(frame);
  if (await frame.evaluate(() => Module.ccall("WebSelectedCar", "string", [], []))) {
    await press(page, frame, "KeyS");
    await frame.waitForFunction(() => !Module.ccall("WebSelectedCar", "string", [], []));
  }
  const seen = new Set();
  while (true) {
    const current = await frame.evaluate(() => tm4Port.selectedCar);
    if (current === car) return frame;
    assert(!seen.has(current), `Car ${car} was not found in the native menu`);
    seen.add(current);
    await press(page, frame, "ArrowRight");
    await frame.waitForFunction(
      (previous) => tm4Port.selectedCar !== previous && tm4Port.menuReady,
      current,
    );
  }
}

export async function confirmCar(page, car) {
  const frame = car
    ? await previewCar(page, car)
    : await (await page.locator("#room-player").elementHandle()).contentFrame();
  await page.bringToFront();
  await frame.waitForFunction(() => tm4Port.screen === "carsel" && tm4Port.menuReady, null, {
    timeout: 120000,
  });
  await closeSettings(frame);
  const revision = await frame.evaluate(() => Module._WebCarSelectionRevision());
  await press(page, frame, "KeyX");
  await frame.waitForFunction((previous) => Module._WebCarSelectionRevision() > previous, revision);
}
