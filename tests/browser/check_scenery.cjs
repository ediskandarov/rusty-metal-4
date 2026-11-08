/* global tm4Port, Module */
/* Original startup instances and callbacks; only diagnostic placement is synthetic. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
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
    if (m.type() === "error" && !/^\[[ID]\]/.test(m.text())) errors.push(m.text());
  });
  const state = () => page.evaluate(() => tm4Port);
  const read = () =>
    page.evaluate(() => {
      Module._WebTestReadScenery();
      return tm4Port.scenery;
    });
  const press = async (key) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
    await page.waitForTimeout(150);
  };
  const screen = (name) =>
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  try {
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await require("./browser_startup.cjs")(page);
    await screen("main");
    await page.locator("canvas").click();
    const maps =
      process.env.TM4_TEST_SCENERY_SCREENS === "1"
        ? ["Neon City", "The Bedroom"]
        : ["Construction Yard", "Neon City", "The Bedroom"];
    for (const map of maps) {
      await press("x");
      await screen("newgame");
      if ((await state()).gameType !== 1) await press("ArrowRight");
      await press("x");
      await screen("dmatch");
      for (let i = 0; i < 32 && (await state()).selectedWorld !== map; ++i)
        await press("ArrowRight");
      assert.equal((await state()).selectedWorld, map);
      await press("x");
      await screen("carsel");
      await press("x");
      await page.waitForFunction(
        () => tm4Port.screen === "level" && tm4Port.levelFrames > 30,
        null,
        { timeout: 30000 },
      );
      const initial = await read();
      console.log("INITIAL", map, initial);
      if (map === "Construction Yard") {
        assert.equal(initial.conveyers, 1);
        assert(initial.ownedPolygons > 0);
        assert(initial.speed !== 0);
        await page.evaluate(() => Module._WebTestApproachScenery(1));
        await page.waitForFunction(
          () => {
            Module._WebTestReadScenery();
            return tm4Port.scenery.surfaceVelocities.some((v) => v.some((x) => x !== 0));
          },
          null,
          { timeout: 12000 },
        );
        console.log("PASS conveyor contact applies surface velocity", await read());
      } else {
        assert.equal(initial.jumbotrons, 2);
        assert(initial.screens.length >= 2);
        await page.evaluate(() => {
          delete tm4Port.testSceneryPlaced;
          Module._WebTestApproachScenery(2);
        });
        await page.waitForFunction(() => tm4Port.testSceneryPlaced);
        await page.waitForTimeout(1000);
        await page.waitForFunction(
          () => {
            Module._WebTestReadScenery();
            return [0, 1].every((side) =>
              tm4Port.scenery.screens.some(
                (s) =>
                  s.side === side &&
                  s.uv[0] === side * 32 &&
                  s.uv[2] === 159 + side * 32 &&
                  s.uv[5] === 239 &&
                  s.uv[7] === 239 &&
                  (s.tpage & 0x180) === 0x100,
              ),
            );
          },
          null,
          { timeout: 12000 },
        );
        const pages = new Set();
        for (let i = 0; i < 16; ++i) {
          const scene = await read();
          for (const face of scene.screens) {
            const page = face.tpage - face.side * 2;
            assert([256, 261].includes(page));
            pages.add(page);
          }
          await page.waitForTimeout(37);
        }
        assert.equal(pages.size, 2, "screen must follow both display buffers");
        console.log(
          "PASS original Jumbotron display updates both framebuffer halves",
          map,
          await read(),
        );
      }
      await page.screenshot({ path: `build/checks/scenery-${map.replaceAll(" ", "-")}.png` });
      assert.deepEqual(errors, []);
      await press("Enter");
      await page.waitForFunction(() => tm4Port.paused === true);
      await press("ArrowUp");
      await press("x");
      await press("ArrowUp");
      await press("x");
      await screen("main");
    }
    assert.deepEqual(errors, []);
    console.log("PASS conveyor and Jumbotron original instances across three levels");
  } catch (e) {
    console.error("STATE", await state(), "ERRORS", errors);
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
