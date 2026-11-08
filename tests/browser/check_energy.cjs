/* global tm4Port, Module */
/* Actions use ordinary keyboard input. Hooks place a contact target and read state. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const actions = [
  { name: "Jump", keys: ["Up", "Up", "Left"], cost: 410, kind: "jump" },
  { name: "Shield", keys: ["Up", "Up", "Right"], cost: 1638, kind: "shield" },
  { name: "Invisibility", keys: ["Down", "Down", "Up", "Up"], cost: 1638, kind: "invisible" },
  { name: "Hyperspace", keys: ["Up", "Up", "Down", "Down"], cost: 1638, kind: "teleport" },
  { name: "Freeze", keys: ["Left", "Right", "Up", "Up"], cost: 1638, slot: 13 },
  { name: "Rear Freeze", keys: ["Left", "Right", "Down", "Down"], cost: 2048, slot: 13 },
  { name: "Rear Attack", keys: ["Right", "Left", "Down", "Down"], cost: 410, slot: 0 },
  { name: "Massive", keys: ["Up", "Down", "Up", "Down", "Up"], cost: 4096, slot: 16 },
  { name: "Rear Massive", keys: ["Up", "Down", "Up", "Down", "Down"], cost: 4096, slot: 16 },
  {
    name: "Destruction",
    keys: ["Up", "Down", "Right", "Left", "Right"],
    cost: 4096,
    kind: "debris",
  },
];
(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (/^WARNING: \[W\].*\[SquareRoot0_impl\] SquareRoot0\(-\d+\)/.test(m.text())) return;
    if (m.type() === "error" && !/^\[[ID]\]/.test(m.text())) errors.push(m.text());
  });
  const press = async (key, down = 150, up = 150) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(down);
    await page.keyboard.up(key);
    await page.waitForTimeout(up);
  };
  const screen = (name) =>
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  const read = () =>
    page.evaluate(() => {
      Module._WebTestReadEnergyActions();
      return tm4Port;
    });
  try {
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await require("./browser_startup.cjs")(page);
    await page.locator("canvas").click();
    for (const action of actions.filter(
      (a) => !process.env.TM4_ENERGY_ACTION || a.name === process.env.TM4_ENERGY_ACTION,
    )) {
      await press("x");
      await screen("newgame");
      await press("x");
      await screen("carsel");
      await press("x");
      await page.waitForFunction(
        () => tm4Port.screen === "level" && tm4Port.levelFrames > 30 && tm4Port.carContact,
        null,
        { timeout: 30000 },
      );
      if (action.slot === 13) {
        assert(
          (await page.evaluate(
            (rear) => Module._WebTestPlaceEnergyTarget(rear),
            action.name === "Rear Freeze",
          )) > 0,
          "no clear level target placement",
        );
        // Let the relocated target settle before the homing launch.
        await page.waitForTimeout(1500);
      }
      if (action.kind === "jump") {
        // Too slow: this must not activate a shield or consume energy.
        for (const key of ["Up", "Up", "Right"]) await press("Arrow" + key, 400, 150);
        const slow = await read();
        assert.equal(slow.energyAction.energy, slow.energyAction.maximum);
        assert.equal(slow.energyAction.shield, 0);
      }
      const before = await read();
      if (action.slot === 13) {
        assert(
          Math.abs(before.energyAction.target.y - before.carY) < 80,
          "contact fixture must keep both cars on the same floor",
        );
      }
      assert.equal(before.energyAction.energy, before.energyAction.maximum);
      for (const key of action.keys) await press("Arrow" + key, 60, 40);
      const after = await read();
      const spent = before.energyAction.energy - after.energyAction.energy;
      assert(
        spent > action.cost - 100 && spent <= action.cost,
        `${action.name} energy: ${spent}, expected cost ${action.cost} minus regeneration`,
      );
      if (action.kind === "jump") {
        assert(after.energyAction.velocityY < 0);
        assert(after.energyAction.objects.includes("carJump"));
        assert(after.carY < before.carY);
      } else if (action.kind === "shield" || action.kind === "invisible") {
        assert(after.energyAction[action.kind] > 150);
        assert(after.energyAction.copiedFaces);
        if (action.kind === "invisible") {
          assert(after.energyAction.copiedColors);
          await page.waitForFunction(() => {
            Module._WebTestReadEnergyActions();
            return tm4Port.energyAction.hidden;
          });
        }
        await page.screenshot({ path: `build/checks/energy-${action.kind}.png` });
        await page.waitForFunction(
          (kind) => {
            Module._WebTestReadEnergyActions();
            return tm4Port.energyAction[kind] === 0;
          },
          action.kind,
          { timeout: 12000 },
        );
        const restored = await read();
        assert.equal(restored.energyAction.faces, before.energyAction.faces);
        assert.equal(restored.energyAction.colors, before.energyAction.colors);
        assert(!restored.energyAction.copiedFaces && !restored.energyAction.copiedColors);
      } else if (action.kind === "teleport") {
        assert(
          Math.hypot(after.carX - before.carX, after.carY - before.carY, after.carZ - before.carZ) >
            100,
        );
        assert(after.cameraAttached);
      } else if (action.kind === "debris") {
        assert((after.debrisSpawns || 0) > (before.debrisSpawns || 0));
      } else {
        assert(
          after.energyAction.weapons[action.slot].nextTime >
            before.energyAction.weapons[action.slot].nextTime,
        );
        assert((after.projectileSpawns || 0) > (before.projectileSpawns || 0));
      }
      if (action.slot === 13) {
        await page.waitForFunction(
          () => {
            Module._WebTestReadEnergyActions();
            return tm4Port.energyAction.target?.freeze > 0;
          },
          null,
          { timeout: 6000 },
        );
        const frozen = await read();
        assert(frozen.energyAction.target.copiedFaces);
        assert.equal(frozen.energyAction.target.throttle, 0);
        await page.waitForFunction(
          () => {
            Module._WebTestReadEnergyActions();
            return tm4Port.energyAction.target?.freeze === 0;
          },
          null,
          { timeout: 7000 },
        );
        const thawed = await read();
        assert.equal(thawed.energyAction.target.faces, before.energyAction.target.faces);
        assert(!thawed.energyAction.target.copiedFaces);
      }
      if (action.slot === 16) {
        await page.waitForFunction((t) => tm4Port.carTicks >= t + 45, after.carTicks);
        const burst = await read();
        for (const [name, count] of Object.entries({
          Freeze: 1,
          Fire: 1,
          Power: 1,
          Homing: 1,
          MIRVbaby: 2,
        })) {
          assert.equal(
            (burst.playerProjectileSpawns?.[name] || 0) -
              (before.playerProjectileSpawns?.[name] || 0),
            count,
            `all delayed player shots of ${name} must run`,
          );
        }
        for (const key of ["Up", "Up", "Right"]) await press("Arrow" + key, 60, 40);
        const denied = await read();
        assert.equal(denied.energyAction.shield, 0);
        assert(
          denied.energyAction.energy >= burst.energyAction.energy,
          "insufficient energy must reject the shield",
        );
      }
      assert.deepEqual(errors, []);
      console.log("PASS", action.name, {
        spent,
        energy: after.energyAction.energy,
        projectiles: after.projectileSpawns,
        debris: after.debrisSpawns,
      });
      await press("Enter");
      await page.waitForFunction(() => tm4Port.paused === true);
      await press("ArrowUp");
      await press("x");
      await press("ArrowUp");
      await press("x");
      await screen("main");
    }
    console.log("PASS energy combinations", process.env.TM4_ENERGY_ACTION || "all ten");
  } catch (e) {
    console.error("STATE", await read(), "ERRORS", errors);
    await page.screenshot({ path: "build/checks/energy-failure.png" });
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
