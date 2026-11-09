/* global Module, tm4Port */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

function motionPairs(samples, predicate) {
  const pairs = [];
  const first = new Map();
  for (const sample of samples.filter(predicate)) {
    const key = sample.address + "/" + sample.id + "/" + sample.tick;
    const previous = first.get(key);
    if (!previous) first.set(key, sample);
    else if (previous.frame !== sample.frame) {
      assert.deepEqual(sample.live, previous.live, "rendering changed the live pose");
      pairs.push([previous, sample]);
    }
  }
  return pairs;
}

(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--disable-frame-rate-limit"],
  });
  const page = await browser.newPage({ viewport: { width: 720, height: 540 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await require("./browser_diagnostics.cjs")(page);
  const menu = (name) =>
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  const press = async (key, down = 150) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(down);
    await page.keyboard.up(key);
    await page.waitForTimeout(150);
  };
  const start = () =>
    page.evaluate(() => {
      tm4Port.motionSamples = [];
      Module._WebTestCaptureMotion(1);
    });
  const stop = () =>
    page.evaluate(() => {
      Module._WebTestCaptureMotion(0);
      return tm4Port.motionSamples;
    });
  try {
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await require("./browser_startup.cjs")(page);
    await page.locator("canvas").click();
    await press("x");
    await menu("newgame");
    await press("x");
    await menu("carsel");
    await press("x");
    await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30, null, {
      timeout: 30000,
    });

    assert.equal(await page.evaluate(() => Module._WebTestPlaceMotionPickups()), 2);
    const toggle = page.locator("#render-interpolation");
    await page.locator("#render-settings summary").click();
    const verifyOff = async () => {
      await start();
      await page.waitForTimeout(200);
      const samples = await stop();
      assert(samples.some(({ pickup }) => pickup));
      for (const { live, render, history } of samples) {
        assert.deepEqual(live, render);
        assert.equal(history, false);
      }
    };
    assert.equal(await toggle.isChecked(), false);
    await verifyOff();
    await toggle.check();
    await page.waitForFunction(
      () => tm4Port.interpolateMotion && tm4Port.renderTiming.vblanks === 1,
    );
    await start();
    await page.waitForTimeout(1700);
    const pickups = await stop();
    for (const [name, isPickup] of [
      ["health", (sample) => sample.pickup && sample.name.startsWith("health")],
      ["weapon", (sample) => sample.pickup && !/^(health|turbo)/i.test(sample.name)],
    ]) {
      const pairs = motionPairs(pickups, isPickup);
      const example = pairs.find(([a, b]) => a.render[3] !== b.render[3]);
      assert(example, name + " has different rendered angles during one simulation tick");
      const angleLag = (angle, rendered) => (angle - rendered + 4096) & 4095;
      assert(
        pairs.some(([a, b]) => b.live[3] < 200 && a.render[3] > 3896),
        name + " crosses angle wrap on the shorter arc",
      );
      for (const sample of pickups.filter(isPickup))
        assert(angleLag(sample.live[3], sample.render[3]) <= 200);
      assert(
        pairs.some(([a, b]) => a.render[1] !== b.render[1]),
        name + " has an intermediate bob height",
      );
      console.log("PICKUP", example);
    }

    await page.locator("#render-settings summary").click();
    await page.locator("canvas").click();
    assert((await page.evaluate(() => Module._WebTestPlaceEnergyTarget(0))) > 0);
    for (const [slot, name] of [
      [6, "Speed"],
      [7, "Rain"],
    ]) {
      assert((await page.evaluate((slot) => Module._WebTestSupplyWeapon(slot), slot)) > 0);
      for (
        let i = 0;
        i < 21 && (await page.evaluate(() => tm4Port.carSelectedWeapon)) !== slot;
        ++i
      )
        await press("r");
      assert.equal(await page.evaluate(() => tm4Port.carSelectedWeapon), slot);
      await start();
      await press("w", 60);
      await page.waitForFunction((name) => tm4Port.playerProjectileRemoved?.[name] > 0, name, {
        timeout: 15000,
      });
      const removalFrame = await page.evaluate(() => tm4Port.levelFrames);
      await page.waitForFunction((frame) => tm4Port.levelFrames >= frame + 4, removalFrame);
      const projectiles = await stop();
      const shot = projectiles.filter((sample) => sample.name === name);
      assert(shot.length, name + " was drawn");
      assert.equal(shot[0].history, false, name + " starts at its actual spawn pose");
      assert.deepEqual(shot[0].live, shot[0].render);
      assert(
        shot.every((sample) => sample.frame <= removalFrame),
        name + " leaves no ghost",
      );
      for (const sample of shot.filter((sample) => sample.impact)) {
        assert.equal(sample.history, false, name + " cuts on impact");
        assert.deepEqual(sample.live, sample.render);
      }
      verifyFlight(projectiles, name);
    }

    await start();
    const address = await page.evaluate(() => Module._WebTestSpawnMotionFireball());
    assert(address > 0);
    const frame = await page.evaluate(() => tm4Port.levelFrames);
    await page.waitForFunction((frame) => tm4Port.levelFrames >= frame + 20, frame);
    const fireballs = (await stop()).filter((sample) => sample.address === address);
    assert(fireballs.length, "diagnostic fireball was drawn");
    assert.equal(fireballs[0].history, false);
    verifyFlight(fireballs, "weaponFireball");

    function verifyFlight(samples, name) {
      const poses = new Map();
      for (const sample of samples.filter((sample) => sample.name === name))
        poses.set(sample.address + "/" + sample.id + "/" + sample.tick, sample.live);
      const pairs = motionPairs(samples, (sample) => sample.name === name);
      const example = pairs.find(([a, b]) => {
        const before = poses.get(a.address + "/" + a.id + "/" + (a.tick - 1));
        if (!before || !a.history || !b.history) return false;
        const between = (sample) =>
          sample.render
            .slice(0, 3)
            .every(
              (value, i) =>
                value >= Math.min(before[i], sample.live[i]) &&
                value <= Math.max(before[i], sample.live[i]),
            );
        return (
          between(a) && between(b) && a.render.slice(0, 3).some((value, i) => value !== b.render[i])
        );
      });
      assert(example, name + " has different rendered positions during one simulation tick");
      console.log("PROJECTILE", example);
    }

    if (!(await page.locator("#render-settings").evaluate((node) => node.open)))
      await page.locator("#render-settings summary").click();
    await toggle.uncheck();
    await page.waitForFunction(
      () => !tm4Port.interpolateMotion && tm4Port.renderTiming.vblanks === 2,
    );
    assert.equal(await page.evaluate(() => Module._WebTestPlaceMotionPickups()), 2);
    await verifyOff();
    assert.deepEqual(errors, []);
    console.log("PASS world motion, spawn/despawn, unchanged live poses and toggle");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
