/* global Module, tm4Port */
const { startDiagnosticGame } = require("./helpers/player.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
(async () => {
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
  await require("./browser_diagnostics.cjs")(page);
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
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
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
    if (process.env.TM4_TEST_CALLBACK_TYPES) await require("./check_object_callbacks.cjs")(page);
    const start = await state();
    console.log("DRIVE START", start);
    if (start.level !== selected.selectedWorld || start.car !== selected.selectedCar)
      throw new Error("Menu selection was not propagated");
    await page.evaluate(() => Module._WebTestDamagePlayer());
    await page.waitForFunction(() => tm4Port.carAlive === 0, null, { timeout: 5000 });
    const dead = await state();
    if (!dead.timerSpawns || !dead.animSpawns || !dead.hudGlyphs)
      throw new Error("Death must produce explosion, respawn timer and HUD text");
    await page.waitForTimeout(500);
    const explosion = await state();
    if (!explosion.debrisSpawns || !explosion.debrisDraws)
      throw new Error("Destroyed car must create and render its model groups");
    await page.screenshot({ path: "build/checks/lifecycle-dead.png" });
    await page.waitForFunction(() => tm4Port.carAlive && tm4Port.cameraAttached, null, {
      timeout: 15000,
    });
    await page.keyboard.down("x");
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => tm4Port.debrisRemoved > 0, null, { timeout: 10000 });
    if (process.env.TM4_TEST_CALLBACK_TYPES) await require("./check_object_callbacks.cjs")(page);
    const revived = await state();
    await page.keyboard.up("x");
    if (revived.carHealth <= 0 || revived.cars.length !== start.cars.length)
      throw new Error("Respawn did not restore the player and roster");
    if (revived.engineVoice < 0 || revived.carThrottle <= 0 || !revived.cameraAttached)
      throw new Error("Respawn must restore engine, controls and camera");
    if (errors.length) throw new Error(errors.join("\n"));
    await page.screenshot({ path: "build/checks/lifecycle-respawn.png" });
    console.log("PASS original damage -> destruction -> tournament timer -> respawn -> camera");
    console.log(JSON.stringify({ start, dead, revived }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
