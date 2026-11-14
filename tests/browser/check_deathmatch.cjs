/* global Module, tm4Port */
/* Rule limits are diagnostic inputs; damage, scoring, timers and transitions are original code. */
const { startDiagnosticGame } = require("./helpers/player.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/^\[[ID]\]/.test(m.text())) errors.push(m.text());
  });
  const state = () =>
    page.evaluate(() => {
      Module._WebTestReadMatchState();
      return tm4Port;
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
    await startDiagnosticGame(page);
    await screen("main");
    await page.locator("canvas").click();
    for (const winsLimit of [false, true]) {
      await press("x");
      await screen("newgame");
      if ((await state()).gameType !== 1) await press("ArrowRight");
      await press("x");
      await screen("dmatch");
      await press("x");
      await screen("carsel");
      await press("x");
      await page.waitForFunction(
        () => tm4Port.screen === "level" && tm4Port.levelFrames > 30,
        null,
        { timeout: 30000 },
      );
      await page.evaluate((wins) => Module._WebTestDeathmatchRules(+wins, 2, +wins), winsLimit);
      await page.waitForFunction((wins) => {
        Module._WebTestReadMatchState();
        return tm4Port.match.limit === 2 && !!tm4Port.match.limitIsWins === wins;
      }, winsLimit);
      let wins = 0;
      for (let round = 0; round < (winsLimit ? 3 : 2); ++round) {
        const before = await state();
        assert.equal(before.match.rounds, round);
        assert.equal(before.match.wins, wins);
        assert(before.carAlive && before.cameraAttached);
        if (round === 0) await page.evaluate(() => Module._WebTestLoseDeathmatchRound());
        else {
          ++wins;
          await page.evaluate(() => Module._WebTestDefeatOpponents());
        }
        await page.waitForFunction(
          () => {
            Module._WebTestReadMatchState();
            return tm4Port.match.roundFinished && tm4Port.match.deathmatchAcceptsInput;
          },
          null,
          { timeout: 20000 },
        );
        const score = await state();
        assert.equal(score.match.rounds, round + 1);
        assert.equal(score.match.wins, wins);
        assert.equal(score.match.losses, 1);
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: `build/checks/deathmatch-${winsLimit ? "wins" : "rounds"}-${round}.png`,
        });
        const last = winsLimit ? wins === 2 : round === 1;
        assert.equal(score.match.deathmatchNextMode, last ? 3 : 2);
        console.log("PASS deathmatch score", {
          winsLimit,
          round: round + 1,
          wins,
          losses: 1,
          world: score.level,
          next: score.match.deathmatchNextMode,
        });
        const sessions = score.loadingHistory.length;
        await press("x");
        if (last) await screen("main");
        else {
          await page.waitForFunction(
            (previous) =>
              tm4Port.screen === "level" &&
              tm4Port.loadingHistory.length > previous &&
              tm4Port.levelFrames > 30,
            sessions,
            { timeout: 30000 },
          );
          const after = await state();
          assert.equal(after.match.rounds, round + 1);
          assert.equal(after.match.wins, wins);
          assert.equal(after.match.losses, 1);
          assert(after.carAlive && after.cameraAttached && after.match.opponents > 0);
          if (winsLimit) assert.notEqual(after.level, before.level);
          else assert.equal(after.level, before.level);
          console.log("PASS next round", before.level, "->", after.level);
        }
        assert.deepEqual(errors, []);
      }
      console.log("PASS deathmatch limit returns to menu", winsLimit ? "wins" : "rounds");
    }
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
