/* global testRumbles, tm4Port, setPad, Module */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const players = Number(process.env.TM4_PLAYERS || 2);
const testWorld = process.env.TM4_TEST_WORLD;
assert(!testWorld || !process.env.TM4_TEST_COOP, "explicit map selection uses Deathmatch");
assert.ok([2, 3, 4].includes(players));

(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  const errors = [];
  const started = Date.now();
  page.on("pageerror", (error) => {
    errors.push(String(error));
    console.error(error.stack);
  });
  page.on("console", (message) => {
    if (/^Loading | initialized:|^FRAME TRACE/.test(message.text()))
      console.log("LOAD", Date.now() - started, message.text());
    if (message.type() === "error" && !/^\[[ID]\]/.test(message.text())) {
      errors.push(message.text());
      console.error(message.text());
    }
  });
  await require("./browser_diagnostics.cjs")(page);
  if (process.env.TM4_TEST_FRAME_TRACE)
    await page.addInitScript(() => {
      setInterval(() => {
        const s = globalThis.tm4Port;
        if (s?.screen === "level")
          console.log(
            "FRAME TRACE",
            JSON.stringify({
              world: s.level,
              frames: s.levelFrames,
              ticks: s.simulationTicks,
              paused: s.paused,
              visibility: document.visibilityState,
              timing: s.renderTiming,
            }),
          );
      }, 5000);
    });
  await page.addInitScript(() => {
    const pads = [];
    window.testRumbles = [];
    navigator.getGamepads = () => pads;
    window.setPad = (index, state = {}) => {
      const connected = state.connected !== false;
      const changed = !!pads[index] !== connected;
      const pad = pads[index] || {
        id: `TM4 virtual pad ${index}`,
        index,
        mapping: "standard",
        connected: true,
        axes: [0, 0, 0, 0],
        vibrationActuator: {
          effects: ["dual-rumble"],
          playEffect(type, effect) {
            testRumbles.push({ index, type, ...effect });
            return Promise.resolve("complete");
          },
        },
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      };
      pad.connected = connected;
      pad.timestamp = performance.now();
      pad.axes = [state.x || 0, state.y || 0, 0, 0];
      pad.buttons = pad.buttons.map((_, button) => ({
        pressed: (state.buttons || []).includes(button),
        touched: (state.buttons || []).includes(button),
        value: (state.buttons || []).includes(button) ? 1 : 0,
      }));
      pads[index] = connected ? pad : null;
      if (changed) {
        const event = new Event(connected ? "gamepadconnected" : "gamepaddisconnected");
        Object.defineProperty(event, "gamepad", { value: pad });
        window.dispatchEvent(event);
      }
    };
  });
  const screen = (name) =>
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  async function button(index, button) {
    await page.evaluate(([index, button]) => setPad(index, { buttons: [button] }), [index, button]);
    await page.waitForTimeout(150);
    await page.evaluate((index) => setPad(index), index);
    await page.waitForTimeout(150);
  }
  const state = async (label) =>
    console.log(
      label,
      await page.evaluate(() => ({
        screen: tm4Port.screen,
        level: tm4Port.level,
        levelFrames: tm4Port.levelFrames,
        simulationTicks: tm4Port.simulationTicks,
        loadingHistory: tm4Port.loadingHistory,
        match: tm4Port.match,
        selected: tm4Port.selected,
        playerCount: tm4Port.playerCount,
        menuPlayer: tm4Port.menuPlayer,
        paused: tm4Port.paused,
        pausePlayer: tm4Port.pausePlayer,
        cars: tm4Port.cars,
        lastDisplay: tm4Port.lastDisplay,
        lastDebris: tm4Port.lastDebris,
      })),
    );
  try {
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await require("./browser_startup.cjs")(page);
    if (testWorld) {
      const key = async (name) => {
        await page.keyboard.down(name);
        await page.waitForTimeout(150);
        await page.keyboard.up(name);
        await page.waitForTimeout(150);
      };
      await key("ArrowUp");
      await key("x");
      await screen("options");
      await key("ArrowDown");
      await key("ArrowDown");
      await key("x");
      await screen("password");
      for (const name of ["s", "ArrowRight", "ArrowUp", "ArrowLeft", "q"]) await key(name);
      await screen("options");
      await key("s");
      await screen("main");
      await key("ArrowDown");
    }
    await page.evaluate((count) => {
      for (let i = 0; i < count; ++i) setPad(i);
    }, players);
    await page.waitForTimeout(300);
    await button(0, 0);
    await screen("newgame");
    if (players >= 3 || testWorld) await button(0, 15); // Deathmatch supports four players.
    await button(0, 13); // Players row.
    for (let i = 1; i < players; ++i) await button(0, 15);
    await page.waitForFunction((count) => tm4Port.playerCount === count, players);
    await button(0, 0);
    if (players >= 3 || testWorld) {
      await screen("dmatch");
      if (testWorld) {
        for (
          let i = 0;
          i < 16 && (await page.evaluate(() => tm4Port.selectedWorld)) !== testWorld;
          ++i
        ) {
          const previous = await page.evaluate(() => tm4Port.selectedWorld);
          await page.evaluate(() => setPad(0, { buttons: [15] }));
          try {
            await page.waitForFunction((previous) => tm4Port.selectedWorld !== previous, previous);
          } finally {
            await page.evaluate(() => setPad(0));
          }
          await screen("dmatch");
          await page.waitForTimeout(150);
        }
        assert.equal(await page.evaluate(() => tm4Port.selectedWorld), testWorld);
      }
      await button(0, 0);
    }
    await screen("carsel");
    for (let i = 0; i < players; ++i) {
      await page.waitForFunction((index) => tm4Port.menuPlayer === index && tm4Port.menuReady, i);
      if (i) await button(i, 15);
      await button(i, 0);
    }
    await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.carTicks > 30, null, {
      timeout: 30000,
    });
    console.log(`${players}-player match started`);
    const checkCallbacks = async () => {
      if (process.env.TM4_TEST_CALLBACK_TYPES) await require("./check_object_callbacks.cjs")(page);
    };
    await checkCallbacks();
    for (let i = 0; i < players; ++i) {
      await page.evaluate((index) => setPad(index, { x: index % 2 ? 0.7 : -0.7, y: -1 }), i);
      await page.waitForFunction(
        (index) =>
          tm4Port.cars.some(
            (c) =>
              c.control === 1 &&
              c.player === index &&
              c.throttle > 0 &&
              (index % 2 ? c.steering > 10000 : c.steering < -10000),
          ),
        i,
      );
      assert.ok(
        await page.evaluate(
          (index) =>
            tm4Port.cars
              .filter((c) => c.control === 1 && c.player !== index)
              .every((c) => c.throttle === 0),
          i,
        ),
        "other controllers remain neutral",
      );
      await page.evaluate((index) => setPad(index), i);
      await page.waitForFunction(
        (index) =>
          tm4Port.cars.some((c) => c.control === 1 && c.player === index && c.throttle === 0),
        i,
      );
    }
    await page.screenshot({ path: `build/checks/multiplayer-${players}-driving.png` });
    await page.evaluate(() => {
      testRumbles.length = 0;
    });
    await page.keyboard.down("e");
    await page.waitForFunction(() =>
      testRumbles.some((r) => r.index === 0 && (r.strongMagnitude > 0 || r.weakMagnitude > 0)),
    );
    await page.keyboard.up("e");
    await button(1, 9);
    await page.waitForFunction(() => tm4Port.paused && tm4Port.pausePlayer === 2);
    const ticks = await page.evaluate(() => tm4Port.carTicks);
    assert.ok(
      await page.evaluate(() =>
        [0, 1].every((index) => {
          const last = testRumbles.filter((r) => r.index === index).at(-1);
          return !last || (last.strongMagnitude === 0 && last.weakMagnitude === 0);
        }),
      ),
      "pause must stop vibration",
    );
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => tm4Port.carTicks), ticks);
    await button(0, 0);
    assert.equal(
      await page.evaluate(() => tm4Port.paused),
      true,
      "only the pausing player should select Resume",
    );
    await button(1, 0);
    await page.waitForFunction((ticks) => !tm4Port.paused && tm4Port.carTicks > ticks, ticks);
    for (const disconnected of [players - 1, 0, 1]) {
      await page.evaluate((index) => setPad(index, { connected: false }), disconnected);
      await page.waitForFunction(() => tm4Port.paused);
      assert.equal(
        await page.evaluate(() => tm4Port.pausePlayer),
        disconnected + 1,
        "pause belongs to the disconnected controller",
      );
      await page.screenshot({
        path: `build/checks/multiplayer-${players}-disconnected-${disconnected}.png`,
      });
      await page.evaluate((index) => setPad(index), disconnected);
      await page.waitForTimeout(300);
      await button(disconnected, 0);
      await page.waitForFunction(() => !tm4Port.paused);
      await page.evaluate((index) => setPad(index, { y: -1 }), disconnected);
      await page.waitForFunction(
        (index) =>
          tm4Port.cars.some((c) => c.control === 1 && c.player === index && c.throttle > 0),
        disconnected,
      );
      assert.ok(
        await page.evaluate(
          (index) =>
            tm4Port.cars
              .filter((c) => c.control === 1 && c.player !== index)
              .every((c) => c.throttle === 0),
          disconnected,
        ),
        "reconnecting must not swap player controls",
      );
      await page.evaluate((index) => setPad(index), disconnected);
      await page.waitForFunction(
        (index) =>
          tm4Port.cars.some((c) => c.control === 1 && c.player === index && c.throttle === 0),
        disconnected,
      );
    }
    if (process.env.TM4_TEST_COOP) {
      assert.equal(players, 2, "co-op life rules need two-player Tournament");
      assert(!process.env.TM4_TEST_PLAYER_TRANSITIONS);
      const readCoop = () =>
        page.evaluate(() => {
          Module._WebTestReadCoop();
          return tm4Port.coop;
        });
      const waitPlayer = (index, alive) =>
        page.waitForFunction(
          ({ index, alive }) => {
            Module._WebTestReadCoop();
            return tm4Port.coop.players[index].alive === alive;
          },
          { index, alive },
          { timeout: 15000 },
        );
      const damage = async (index) => {
        await page.evaluate((i) => Module._WebTestCoopDamage(i), index);
        await waitPlayer(index, false);
      };
      for (const shared of [0, 1]) {
        if (shared) {
          await button(0, 0);
          await screen("newgame");
          assert.equal(await page.evaluate(() => tm4Port.gameType), 0);
          assert.equal(await page.evaluate(() => tm4Port.playerCount), 2);
          await button(0, 0);
          await screen("carsel");
          for (let i = 0; i < 2; ++i) {
            await page.waitForFunction((i) => tm4Port.menuPlayer === i && tm4Port.menuReady, i);
            await button(i, 0);
          }
          await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30);
        }
        assert.equal(await page.evaluate((shared) => Module._WebTestCoopSetup(shared), shared), 1);
        await page.waitForFunction((shared) => {
          Module._WebTestReadCoop();
          return (
            tm4Port.coop.shared === shared &&
            tm4Port.coop.players[0].lives === 0 &&
            tm4Port.coop.players[1].lives === 1
          );
        }, shared);
        await damage(0);
        if (shared) {
          assert.equal((await readCoop()).players[1].lives, 0, "the partner donates a life");
          await waitPlayer(0, true);
          assert((await readCoop()).players[0].attached, "respawn restores player-one camera");
          await damage(0);
        }
        const eliminated = await readCoop();
        assert(eliminated.players[0].eliminated && eliminated.players[1].alive);
        assert.equal(eliminated.lost, 0, "one survivor keeps the match running");
        assert(eliminated.players.every((p) => p.camera));
        const ticks = await page.evaluate(() => tm4Port.simulationTicks);
        await page.evaluate(() => setPad(1, { y: -1 }));
        await page.waitForFunction(
          (ticks) =>
            tm4Port.simulationTicks > ticks + 160 &&
            tm4Port.cars.some((c) => c.player === 1 && c.control === 1 && c.throttle > 0),
          ticks,
        );
        await page.evaluate(() => setPad(1));
        assert.equal(
          (await readCoop()).players[0].alive,
          false,
          "eliminated player must not respawn",
        );
        await button(1, 9);
        await page.waitForFunction(() => tm4Port.paused);
        assert.equal(await page.evaluate(() => tm4Port.pausePlayer), 2);
        await button(1, 0);
        await page.waitForFunction(() => !tm4Port.paused);
        await page.screenshot({ path: `build/checks/coop-survivor-${shared}.png` });
        const worlds = Number(process.env.TM4_TEST_COOP_WORLDS || 1);
        const tournamentWorlds = await page.evaluate(() => {
          Module._WebTestReadMatchState();
          return tm4Port.match.tournamentWorlds;
        });
        assert(Number.isInteger(worlds) && worlds >= 1 && worlds <= tournamentWorlds);
        const firstWorld = await page.evaluate(() => tm4Port.level);
        const visited = new Set();
        for (let round = 0; round < worlds; ++round) {
          const previousWorld = await page.evaluate(() => tm4Port.level);
          assert(!visited.has(previousWorld), "co-op worlds must not repeat before completion");
          visited.add(previousWorld);
          const remainingLives = (await readCoop()).players.map((p) => p.lives);
          const deadline = Date.now() + 60000;
          while (Date.now() < deadline) {
            const won = await page.evaluate(() => {
              Module._WebTestReadMatchState();
              return (
                (tm4Port.match.won || tm4Port.match.tournamentWon) && tm4Port.match.acceptsInput
              );
            });
            if (won) break;
            await page.evaluate(() => Module._WebTestDefeatOpponents());
            await page.waitForTimeout(500);
            assert.deepEqual(errors, []);
            await checkCallbacks();
          }
          assert(
            await page.evaluate(
              () =>
                (tm4Port.match.won || tm4Port.match.tournamentWon) && tm4Port.match.acceptsInput,
            ),
          );
          const tournamentWon = await page.evaluate(() => tm4Port.match.tournamentWon);
          assert.equal(!!tournamentWon, round === tournamentWorlds - 1);
          console.log("CONFIRM tournament world", { shared, round: round + 1, previousWorld });
          await button(1, 0); // The surviving player advances the tournament.
          await page.waitForFunction(
            (previous) =>
              tm4Port.screen === "level" && tm4Port.level !== previous && tm4Port.levelFrames > 30,
            previousWorld,
            { timeout: 30000 },
          );
          const advanced = await readCoop();
          assert(
            advanced.players.every((p) => p.alive && p.attached),
            "the original spawn routine recreates both players on the next map",
          );
          assert.deepEqual(
            advanced.players.map((p) => p.lives),
            tournamentWon ? [4, 4] : remainingLives,
            "the first tournament world restores four lives; other worlds preserve them",
          );
          await page.evaluate(() => setPad(0, { y: -1 }));
          await page.waitForFunction(() =>
            tm4Port.cars.some((c) => c.control === 1 && c.player === 0 && c.throttle > 0),
          );
          await page.evaluate(() => setPad(0));
          console.log(
            "PASS survivor advances co-op tournament; roster, cameras and controls restored",
            { shared, round: round + 1, world: previousWorld },
          );
          if (round + 1 < worlds) {
            await damage(0);
            assert((await readCoop()).players[1].alive);
          }
        }
        if (worlds === tournamentWorlds) {
          assert.equal(await page.evaluate(() => tm4Port.level), firstWorld);
          assert.equal(visited.size, tournamentWorlds);
          assert.equal(
            await page.evaluate(() => !!tm4Port.movie?.active),
            false,
            "the original two-player tournament does not select a character ending",
          );
          console.log("PASS full co-op tournament and restart", { shared, worlds });
          // Reuse the short game-over scenario after verifying the real four-life reset.
          await page.evaluate((shared) => Module._WebTestCoopSetup(shared), shared);
          await page.waitForFunction(() => {
            Module._WebTestReadCoop();
            return tm4Port.coop.players[0].lives === 0 && tm4Port.coop.players[1].lives === 1;
          });
          if (shared) {
            await damage(0);
            await waitPlayer(0, true);
            assert.equal((await readCoop()).players[1].lives, 0);
          }
        }
        await damage(0);
        await damage(1);
        if (!shared) {
          await waitPlayer(1, true);
          const revived = await readCoop();
          assert.equal(revived.players[1].lives, 0);
          assert(revived.players[1].attached);
          await damage(1);
        }
        await page.waitForFunction(() => {
          Module._WebTestReadCoop();
          return tm4Port.coop.lost;
        });
        await screen("main");
        assert.deepEqual(errors, []);
        console.log("PASS co-op lives, survivor controls/camera/pause and game over", { shared });
      }
    }
    if (process.env.TM4_TEST_PLAYER_ROUNDS) {
      assert(players >= 3, "this route checks third/fourth-player round ownership");
      assert(!process.env.TM4_TEST_COOP && !process.env.TM4_TEST_PLAYER_TRANSITIONS);
      const match = () =>
        page.evaluate(() => {
          Module._WebTestReadMatchState();
          return tm4Port.match;
        });
      await page.evaluate(() => Module._WebTestDeathmatchRules(0, 2, 1));
      await page.waitForFunction(() => {
        Module._WebTestReadMatchState();
        return tm4Port.match.limit === 2;
      });
      const scores = Array.from({ length: players }, () => ({ wins: 0, losses: 0 }));
      for (let round = 0; round < 2; ++round) {
        const winner = players - 1 - round;
        const previousWorld = await page.evaluate(() => tm4Port.level);
        for (let player = 0; player < players; ++player) {
          if (player === winner) continue;
          await page.evaluate((player) => Module._WebTestCoopDamage(player), player);
          await page.waitForFunction(
            (player) => !tm4Port.cars.some((car) => car.control === 1 && car.player === player),
            player,
          );
        }
        await page.evaluate(() => Module._WebTestDefeatOpponents());
        await page.waitForFunction(
          () => {
            Module._WebTestReadMatchState();
            return tm4Port.match.roundFinished && tm4Port.match.deathmatchAcceptsInput;
          },
          null,
          { timeout: 20000 },
        );
        const result = await match();
        scores.forEach((score, player) => {
          if (player === winner) ++score.wins;
          else ++score.losses;
        });
        assert.equal(result.winner, winner);
        assert.equal(result.rounds, round + 1);
        assert.deepEqual(result.players, scores);
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: `build/checks/deathmatch-${players}-player-round-${round}.png`,
        });
        await button(winner, 0);
        if (round === 1) await screen("main");
        else {
          await page.waitForFunction(
            (previous) =>
              tm4Port.screen === "level" && tm4Port.level !== previous && tm4Port.levelFrames > 30,
            previousWorld,
            { timeout: 30000 },
          );
          assert.deepEqual((await match()).players, scores);
          await page.evaluate(() => Module._WebTestReadCoop());
          const restored = await page.evaluate(() => tm4Port.coop.players);
          assert.equal(restored.length, players);
          assert(restored.every((player) => player.alive && player.attached));
        }
        console.log("PASS multiplayer deathmatch round, scores and winner confirmation", {
          players,
          round: round + 1,
          winner: winner + 1,
          scores,
        });
      }
      assert.deepEqual(errors, []);
    }
    if (process.env.TM4_TEST_PLAYER_TRANSITIONS) {
      for (const count of [2, 1, 4]) {
        await button(0, 9);
        await page.waitForFunction(() => tm4Port.paused);
        await button(0, 12);
        await button(0, 0); // Quit.
        await button(0, 12);
        await button(0, 0); // Yes.
        await screen("main");
        await button(0, 0);
        await screen("newgame");
        if (await page.evaluate(() => tm4Port.selected === 0)) await button(0, 13);
        for (let attempt = 0; attempt < 4; ++attempt) {
          if (await page.evaluate((count) => tm4Port.playerCount === count, count)) break;
          await button(0, 15);
        }
        assert.equal(await page.evaluate(() => tm4Port.playerCount), count);
        await button(0, 0);
        await screen("dmatch");
        await button(0, 0);
        await screen("carsel");
        for (let i = 0; i < count; ++i) {
          await page.waitForFunction(
            (index) => tm4Port.menuPlayer === index && tm4Port.menuReady,
            i,
          );
          await button(i, 0);
        }
        await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30);
        assert.deepEqual(
          await page.evaluate(() => tm4Port.cameraSlots),
          Array.from({ length: 8 }, (_, i) => i < count),
          "unused cameras must not survive the previous match",
        );
        assert.equal(
          await page.evaluate(() => tm4Port.cars.filter((c) => c.control === 1).length),
          count,
        );
        for (let i = 0; i < count; ++i) {
          await page.evaluate((index) => setPad(index, { y: -1 }), i);
          await page.waitForFunction(
            (index) =>
              tm4Port.cars.some((c) => c.control === 1 && c.player === index && c.throttle > 0),
            i,
          );
          assert.ok(
            await page.evaluate(
              (index) =>
                tm4Port.cars
                  .filter((c) => c.control === 1 && c.player !== index)
                  .every((c) => c.throttle === 0),
              i,
            ),
          );
          await page.evaluate((index) => setPad(index), i);
          await page.waitForFunction(
            (index) =>
              tm4Port.cars.some((c) => c.control === 1 && c.player === index && c.throttle === 0),
            i,
          );
        }
        await page.screenshot({ path: `build/checks/multiplayer-restart-${count}.png` });
        console.log(
          `PASS restarted session with ${count} players, fresh cameras and independent controls`,
        );
      }
    }
    if (process.env.TM4_TEST_OVERLAY_RELOAD) {
      const generations = await page.evaluate(() => tm4Port.carSearchGenerationsAtLoad);
      assert(generations.length > 1, "the reload check requires multiple sessions");
      for (const initial of generations)
        assert.deepEqual(initial, [0, 0, 0], "each o_car load must restore its search state");
      console.log("PASS initial AI search state across", generations.length, "module loads");
    }
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${players}-player selection, independent controls, player-two pause, disconnect/reconnect and game-driven vibration`,
    );
  } catch (error) {
    if (error.name === "TimeoutError" && process.env.TM4_TEST_FRAME_TRACE) {
      await state("timeout sample");
      await page.waitForTimeout(5000);
    }
    await state("failure").catch((error) => console.error("State unavailable:", error.message));
    console.log(
      "errors",
      errors,
      await page.evaluate(() => ({
        rumbles: testRumbles.slice(-10),
        bullets: globalThis.tm4Port?.bulletSpawns,
        bindings: globalThis.tm4Port?.controlBindings,
      })),
    );
    await page.screenshot({ path: "build/checks/multiplayer-failure.png" });
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
