/* global tm4Port */
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
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
    await require("./browser_startup.cjs")(page);
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
    const shots = [];
    for (const name of ["Homing", "Power", "Napalm"]) {
      for (
        let i = 0;
        i < 21 && (await state()).weaponName.toLowerCase() !== name.toLowerCase();
        i++
      )
        await press("r");
      const before = await state();
      if (before.weaponName.toLowerCase() !== name.toLowerCase() || before.weaponAmmo <= 0)
        throw new Error("Cannot select " + name + ": " + JSON.stringify(before));
      await press("w");
      await page.waitForFunction(
        (before) => tm4Port.projectileSpawns > (before.projectileSpawns || 0),
        before,
        { timeout: 5000 },
      );
      await page.waitForTimeout(500);
      const fired = await state();
      if (fired.weaponAmmo >= before.weaponAmmo)
        throw new Error("Weapon did not consume ammunition: " + name);
      await page.screenshot({ path: "build/checks/weapon-" + name.toLowerCase() + ".png" });
      await page.waitForFunction(
        (before) =>
          tm4Port.projectileImpacts > (before.projectileImpacts || 0) &&
          tm4Port.projectileRemoved > (before.projectileRemoved || 0) &&
          tm4Port.projectileDraws > (before.projectileDraws || 0),
        before,
        { timeout: 15000 },
      );
      shots.push({ name, before, fired, after: await state() });
      console.log("PASS weapon", name);
    }
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(JSON.stringify(shots, null, 2));
    console.log("PASS original weapon selection -> fire -> ammo -> rendering -> impact -> removal");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
