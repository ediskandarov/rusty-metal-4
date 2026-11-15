/* global Module, tm4Port */
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";

const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.goto(new URL("?session=1", process.env.TM4_WEB_URL ?? "http://127.0.0.1:8351/").href);
  await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
  const open = async () => {
    assert.equal(await page.evaluate(() => Module._WebSetTournamentSelection(1)), 1);
    await page.waitForFunction(() => tm4Port.screen === "carsel" && tm4Port.menuReady, null, {
      timeout: 30000,
    });
    await page.locator("canvas").focus();
  };
  await open();
  const before = await page.evaluate(() => tm4Port.selectedCar);
  await page.keyboard.press("ArrowRight", { delay: 150 });
  await page.waitForFunction((first) => tm4Port.selectedCar !== first, before);
  await page.keyboard.press("KeyX", { delay: 150 });
  await page.waitForFunction(() => Module.ccall("WebTournamentSelectedCar", "string", [], []));
  const confirmed = await page.evaluate(() =>
    Module.ccall("WebTournamentSelectedCar", "string", [], []),
  );
  assert(confirmed);
  assert(await page.evaluate((car) => tm4Port.catalog.cars.includes(car), confirmed));
  await page.keyboard.press("ArrowRight", { delay: 150 });
  assert.equal(
    await page.evaluate(() => Module.ccall("WebTournamentSelectedCar", "string", [], [])),
    confirmed,
  );
  assert.equal(
    await page.evaluate(() => tm4Port.menuMode),
    0,
    "Confirm must not launch an offline tournament",
  );
  await page.screenshot({ path: "build/checks/tournament-selection.png" });
  await page.keyboard.press("KeyS", { delay: 150 });
  await page.waitForFunction(() => !Module.ccall("WebTournamentSelectedCar", "string", [], []));
  await page.evaluate(() => Module._WebSetTournamentSelection(0));
  await page.waitForFunction(() => !tm4Port.menuReady);
  await open();
  assert.equal(
    await page.evaluate(() => Module.ccall("WebTournamentSelectedCar", "string", [], [])),
    "",
  );
  const replay = async (target) =>
    target.evaluate(() => {
      const check = (value, message) => {
        if (!value) throw new Error(message);
      };
      check(
        Module.ccall(
          "WebNetStartFfa",
          "number",
          [
            "number",
            "number",
            "number",
            "number",
            "number",
            "number",
            "string",
            "string",
            "number",
            "string",
            "number",
            "number",
            "number",
          ],
          [
            8,
            3,
            0,
            12345,
            -1,
            1,
            "Orbital\nPizza Boy",
            "0000000000000001\n0000000000000002",
            12,
            "Orbital\nPizza Boy",
            27000,
            100,
            0,
          ],
        ),
        "FFA start refused",
      );
      const states = [];
      for (let tick = 0; tick < 30; tick++) {
        check(Module._WebNetSetInput(tick, 0, 0x40, 0, 0), "driver input refused");
        check(Module._WebNetSetInput(tick, 1, 0, 0, 0), "opponent input refused");
        check(Module._WebNetQueueTick(tick), "FFA step refused");
        check(!tm4Port.netMatch.unsupported, tm4Port.netMatch.unsupported);
        states.push({ tick: tm4Port.netMatch.tick, sections: tm4Port.netMatch.sections });
      }
      return states;
    });
  await page.evaluate(() => Module._WebSetTournamentSelection(0));
  await page.waitForFunction(() => !tm4Port.menuReady);
  const afterMenu = await replay(page);
  const fresh = await browser.newPage();
  fresh.on("pageerror", (error) => errors.push(error.stack));
  await fresh.goto(new URL("?session=1", process.env.TM4_WEB_URL ?? "http://127.0.0.1:8351/").href);
  await fresh.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
  const freshStates = await replay(fresh);
  assert.deepEqual(
    freshStates,
    afterMenu,
    "Menu selection must not change subsequent FFA simulation",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS native selection, confirmation, back, reopening and 30 FFA ticks identical to a fresh session",
  );
} finally {
  await browser.close();
}
