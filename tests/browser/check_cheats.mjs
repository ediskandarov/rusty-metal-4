import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
/* global Module, tm4Port */
import { startDiagnosticGame, togglePanel } from "./helpers/player.mjs";

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 720 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
  await startDiagnosticGame(page);
  await togglePanel(page, "cheat-settings");
  assert.equal(await page.evaluate(() => Module._WebGetCheats()), 0);
  assert.equal(await page.evaluate(() => Module._WebSetCheat(-1, 1)), 0);
  const ids = await page
    .locator("[data-cheat]")
    .evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.cheat)));
  for (const id of ids) {
    await page.locator(`[data-cheat="${id}"]`).check();
    await page.waitForFunction((id) => !!(Module._WebGetCheats() & (1 << id)), id);
  }
  await page.locator("#cheat-reset").click();
  await page.waitForFunction(() => Module._WebGetCheats() === 0);
  assert.equal(await page.locator("[data-cheat]:checked").count(), 0);
  for (const id of [1, 16, 21]) await page.locator(`[data-cheat="${id}"]`).check();
  await page.screenshot({ path: "build/checks/cheats-menu.png" });
  await togglePanel(page, "render-settings");
  await page.waitForFunction(() => !document.getElementById("cheat-settings").open);
  await page.locator("#render-reset").click();
  assert.equal(await page.evaluate(() => Module._WebGetCheats()), (1 << 1) | (1 << 16) | (1 << 21));
  await page.locator("canvas").click({ position: { x: 10, y: 350 } });
  const press = async (key) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
    await page.waitForTimeout(160);
  };
  const screen = (name) =>
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  await press("x");
  await screen("newgame");
  await press("x");
  await screen("carsel");
  const initial = await page.evaluate(() => tm4Port.selectedCar);
  const seen = new Set();
  for (let i = 0; i < 32; ++i) {
    seen.add(await page.evaluate(() => tm4Port.selectedCar));
    await press("ArrowRight");
    await screen("carsel");
    if (await page.evaluate((initial) => tm4Port.selectedCar === initial, initial)) break;
  }
  assert.equal(seen.size, 22);
  console.log("PASS unlock all cars:", seen.size);
  await press("x");
  await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 20, null, {
    timeout: 30000,
  });
  assert.equal(await page.evaluate(() => tm4Port.weaponAmmo), 99);
  console.log("PASS original ammo cheat applied at car construction");
  await togglePanel(page, "cheat-settings");
  await page.locator("#cheat-reset").click();
  await page.waitForFunction(() => Module._WebGetCheats() === 0);
  assert.equal(
    await page.evaluate(() => tm4Port.weaponAmmo),
    99,
    "disable must not rewrite already granted ammo",
  );
  await page.setViewportSize({ width: 320, height: 480 });
  const panel = await page.locator("#cheat-panel").boundingBox();
  assert(panel.x >= 0 && panel.x + panel.width <= 320 && panel.y + panel.height <= 480);
  await page.locator("#cheat-reset").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "build/checks/cheats-narrow.png" });
  assert.deepEqual(errors, []);
  console.log("PASS toggles, separate reset, live disable, narrow menu; no JS errors");
} finally {
  await browser.close();
}
