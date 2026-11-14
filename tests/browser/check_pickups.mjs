import { launchBrowser } from "./helpers/browser.mjs";
/* global Module */
import { startDiagnosticGame } from "./helpers/player.mjs";

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
const errors = [];
page.on("pageerror", (e) => {
  errors.push(String(e));
  console.log("EXCEPTION", e.stack);
});
page.on("console", (m) => {
  console.log(m.type(), m.text());
  if (m.type() === "error" && !/^\[[ID]\]/.test(m.text())) errors.push(m.text());
});
const state = () => page.evaluate(() => globalThis.tm4Port);
async function press(key) {
  await page.keyboard.down(key);
  await page.waitForTimeout(150);
  await page.keyboard.up(key);
  await page.waitForTimeout(150);
}
async function screen(name) {
  await page.waitForFunction(
    (name) => globalThis.tm4Port?.screen === name && globalThis.tm4Port?.menuReady,
    name,
    { timeout: 30000 },
  );
  console.log("SCREEN", await state());
}
try {
  await page.goto("http://127.0.0.1:8080/");
  await startDiagnosticGame(page);
  await screen("main");
  await page.locator("canvas").click();
  await press("x");
  await screen("newgame");
  await press("x");
  await screen("carsel");
  const selected = await state();
  if (selected.selectedWorld !== "Construction Yard" || selected.selectedCar !== "Orbital")
    throw new Error("Unexpected initial selection");
  await page.screenshot({ path: "build/checks/original-car-selection.png" });
  await press("x");
  await page.waitForFunction(() => globalThis.tm4Port?.carTicks > 30, null, { timeout: 30000 });
  const start = await state();
  console.log("DRIVE START", start);
  if (start.level !== selected.selectedWorld || start.car !== selected.selectedCar)
    throw new Error("Menu selection was not propagated");
  if (!start.pickupInstances || !start.pickupDraws)
    throw new Error("Level pickups must be instantiated and rendered");
  if (!(await page.evaluate(() => Module._WebTestApproachPickup())))
    throw new Error("No suitable weapon pickup in original world instances");
  const pickup = (await state()).testPickup;
  console.log("PICKUP", JSON.stringify(pickup));
  await page.waitForFunction(() => Module._WebTestPickupActive() === 0, null, { timeout: 10000 });
  const amount = await page.evaluate(() => Module._WebTestPickupAmount());
  if (amount !== Math.min(pickup.maximum, pickup.before + pickup.units))
    throw new Error(`Inventory mismatch: ${amount}, ${JSON.stringify(pickup)}`);
  await page.evaluate(() => Module._WebTestLeavePickup());
  await page.waitForTimeout(500);
  const collected = await state();
  if (!collected.flareSpawns || !collected.flareDraws)
    throw new Error("Pickup sparkle must be created and drawn");
  await page.screenshot({ path: "build/checks/pickup-collected.png" });
  await page.waitForFunction(() => Module._WebTestPickupActive() === 1, null, {
    timeout: (pickup.respawnTicks / 30) * 1000 + 20000,
  });
  const end = await state();
  if (!end.pickupCollections || !end.pickupRespawns)
    throw new Error("Missing pickup interaction or regeneration");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS original world instances -> spatial interaction -> inventory -> timed regeneration",
  );
  console.log(JSON.stringify({ pickup, amount, end }, null, 2));
} finally {
  await browser.close();
}
