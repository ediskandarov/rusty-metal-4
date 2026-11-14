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
    const diagnostic = process.env.TM4_TEST_PROXIMITY === "1";
    for (const name of diagnostic ? ["Proximity"] : ["Remote"]) {
      if (diagnostic && !(await page.evaluate(() => Module._WebTestSupplyProximity())))
        throw new Error("Cannot supply proximity ammunition through original inventory");
      for (
        let i = 0;
        i < 21 && (await state()).weaponName.toLowerCase() !== name.toLowerCase();
        i++
      )
        await press("r");
      const before = await state();
      console.log("BOMB BEFORE", before);
      if (before.weaponName.toLowerCase() !== name.toLowerCase() || before.weaponAmmo <= 0)
        throw new Error("Cannot select " + name);
      await press("w");
      await page.waitForFunction(
        (before) => tm4Port.bombSpawns > (before.bombSpawns || 0),
        before,
        { timeout: 5000 },
      );
      const planted = await state();
      if (planted.weaponAmmo >= before.weaponAmmo) throw new Error("Bomb ammo did not decrease");
      console.log("PLANTED", planted);
      if (name === "Remote") {
        await page.keyboard.down("s");
        await page.waitForTimeout(600);
        await page.keyboard.up("s");
        await page.waitForTimeout(1600);
        await page.screenshot({ path: "build/checks/bomb-planted.png" });
        console.log("BEFORE DETONATION", await state());
        await press("w");
      } else await page.waitForTimeout(2200);
      await page.waitForFunction(
        (before) =>
          tm4Port.bombRemoved > (before.bombRemoved || 0) &&
          tm4Port.shockwaveSpawns > (before.shockwaveSpawns || 0),
        before,
        { timeout: 15000 },
      );
      await page.screenshot({ path: "build/checks/bomb-" + name.toLowerCase() + ".png" });
      await page.waitForFunction(
        (before) => tm4Port.shockwaveRemoved > (before.shockwaveRemoved || 0),
        before,
        { timeout: 10000 },
      );
      const after = await state();
      if (
        after.carHealth >= before.carHealth ||
        !after.shockwaveDraws ||
        !(after.shockwaveCarHits > (before.shockwaveCarHits || 0))
      )
        throw new Error("Mine must damage the nearby car and render its shockwave");
      console.log("PASS bomb", name, after);
    }
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("PASS original mine selection -> placement -> explosion -> shockwave lifecycle");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
