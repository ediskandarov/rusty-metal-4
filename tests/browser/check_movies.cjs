/* global tm4Port, movieProbe, Module, stringToNewUTF8, _free */
/* Real STR/XA decoding, startup/skip policy, replay and asynchronous fetch cleanup. */
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
  await require("./browser_diagnostics.cjs")(page);
  const press = async (key) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(120);
    await page.keyboard.up(key);
  };
  const state = () => page.evaluate(() => tm4Port.movie);
  const menu = () =>
    page.waitForFunction(
      () => tm4Port.screen === "main" && tm4Port.menuReady && !tm4Port.movie.active,
      null,
      { timeout: 30000 },
    );
  const probe = () => page.evaluate(() => movieProbe);
  try {
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await page.waitForFunction(() => globalThis.tm4Port?.movie && !tm4Port.movie.loading);
    await page.waitForTimeout(300);
    if (await page.evaluate(() => Module.SDL3.audioContext.state !== "running"))
      assert.equal(
        (await state()).frame,
        0,
        "autoplay restriction must hold the studio until audio is unlocked",
      );
    await page.evaluate(() => {
      globalThis.movieProbe = { peak: 0, nonzero: 0, buffers: 0 };
      const node = Module.SDL3.audio_playback.scriptProcessorNode,
        render = node.onaudioprocess;
      node.onaudioprocess = (event) => {
        render(event);
        movieProbe.buffers++;
        for (let c = 0; c < event.outputBuffer.numberOfChannels; c++)
          for (const v of event.outputBuffer.getChannelData(c)) {
            movieProbe.peak = Math.max(movieProbe.peak, Math.abs(v));
            movieProbe.nonzero += v !== 0;
          }
      };
    });
    if (await page.locator("#tm4-movie-start").count())
      await page.locator("#tm4-movie-start").click();
    else await page.locator("canvas").click();
    const started = Date.now();
    await page.waitForFunction(() => tm4Port.movie.frame >= 12);
    await press("Enter");
    assert.equal((await state()).name, "N89STUDI", "studio cannot be skipped");
    await page.waitForFunction(() => tm4Port.movie.frame >= 40);
    await page.screenshot({ path: "build/checks/movie-studio.png" });
    const audio = await probe();
    assert(audio.nonzero > 0 && audio.peak > 0.001, "native XA must reach actual SPU output");
    await page.waitForFunction(() => tm4Port.movie.name === "INTRO");
    const duration = Date.now() - started;
    const studio = await page.evaluate(() => tm4Port.movieHistory[0]);
    assert.equal(studio.reason, "complete");
    assert.equal(studio.frame, 80);
    assert(duration > 4300 && duration < 8000, `15 fps studio duration: ${duration}`);
    await page.waitForFunction(() => tm4Port.movie.frame >= 155, null, { timeout: 20000 });
    const intro = await state();
    assert(
      Math.abs(intro.frame - intro.audioFrames / 2940) < 2,
      "video clock follows native XA consumption",
    );
    await page.screenshot({ path: "build/checks/movie-intro.png" });
    if (process.env.TM4_TEST_MOVIE_FULL_INTRO) {
      await page.waitForFunction(() => !tm4Port.movie.active, null, { timeout: 240000 });
      await menu();
      assert.equal((await state()).reason, "complete");
      assert.equal((await state()).frame, 3252);
      console.log("PASS complete INTRO including its silent XA tail", await state());
    } else {
      await press("x");
      await menu();
      assert.equal((await state()).reason, "skipped");
    }
    console.log("PASS original startup", { duration, studioFrames: studio.frame, audio, intro });
    if (await page.evaluate(() => typeof Module._WebTestMovie === "function")) {
      await page.evaluate(() => Module._WebTestMovie(0));
      await page.waitForFunction(() => tm4Port.movie.playing && tm4Port.movie.frame >= 30);
      await press("Enter");
      await menu();
      assert.equal((await state()).reason, "skipped");
      await page.evaluate(() => Module._WebTestMovie(0));
      await page.waitForFunction(() => tm4Port.movie.playing && tm4Port.movie.frame >= 30);
      await menu();
      assert.equal((await state()).reason, "complete");
      assert.equal((await state()).frame, 80);
      // Delay delivery, skip before it arrives, then verify stale data cannot start a movie.
      await page.route("**/movies/GENERIC.STR", async (route) => {
        await new Promise((r) => setTimeout(r, 1200));
        await route.continue();
      });
      await page.evaluate(() => Module._WebTestMovie(1));
      await page.waitForFunction(() => tm4Port.movie.active && tm4Port.movie.name === "GENERIC");
      await press("Enter");
      await menu();
      await page.waitForTimeout(1600);
      await menu();
      assert.equal((await state()).reason, "skipped");
      await page.unroute("**/movies/GENERIC.STR");
      await page.route("**/movies/GENERIC.STR", (route) =>
        route.fulfill({ status: 200, body: Buffer.alloc(2352) }),
      );
      await page.evaluate(() => Module._WebTestMovie(1));
      await page.waitForFunction(
        () => tm4Port.movie.name === "GENERIC" && tm4Port.movie.reason === "decode failed",
      );
      await menu();
      assert.equal(
        (await state()).reason,
        "decode failed",
        "invalid data must release movie state",
      );
      await page.unroute("**/movies/GENERIC.STR");
      console.log("PASS repeat, natural completion, skip, stale fetch and decode failure cleanup");
      if (process.env.TM4_TEST_MOVIE_ENDING) {
        await page.unroute("**/movies/GENERIC.STR");
        const screen = (name) =>
          page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name);
        await press("x");
        await screen("newgame");
        await press("x");
        await screen("carsel");
        await press("x");
        await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30);
        assert.equal(await page.evaluate(() => Module._WebTestEndingHandoff()), 1);
        await page.waitForFunction(() => tm4Port.movie.active && tm4Port.movie.frame > 30, null, {
          timeout: 30000,
        });
        assert.equal((await state()).name, "ORBITAL");
        await press("Enter");
        assert((await state()).active, "character ending is unskippable");
        await page.screenshot({ path: "build/checks/movie-ending.png" });
        await page.waitForFunction(() => !tm4Port.movie.active, null, { timeout: 90000 });
        await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30);
        const ending = await state();
        assert.equal(ending.reason, "complete");
        assert.equal(ending.frame, ending.frames);
        console.log(
          "PASS live-session teardown, character ending and gameplay continuation",
          ending,
        );
        assert(
          (await page.evaluate(() => tm4Port)).carAlive,
          "gameplay can restart after an ending",
        );
      }
    }
    if (process.env.TM4_TEST_MOVIE_CORPUS) {
      const fs = require("node:fs"),
        path = require("node:path");
      const directory = process.env.TM4_MOVIE_ASSETS || "build/checks/site/movies";
      const files = fs
        .readdirSync(directory)
        .filter((file) => /^[A-Z0-9]+\.STR$/.test(file))
        .sort();
      assert.equal(files.length, 16, "all original movie assets must be present");
      assert(
        await page.evaluate(() => typeof Module._WebTestNamedMovie === "function"),
        "movie corpus requires a diagnostic build",
      );
      for (const file of files) {
        const name = path.basename(file, ".STR"),
          bytes = fs.readFileSync(path.join(directory, file));
        let expectedFrames = 0;
        assert.equal(bytes.length % 2352, 0, "whole raw sectors");
        for (let offset = 0; offset < bytes.length; offset += 2352)
          if (
            bytes.readUInt16LE(offset + 24) === 0x160 &&
            bytes.readUInt16LE(offset + 26) === 0x8001
          )
            expectedFrames = Math.max(expectedFrames, bytes.readUInt32LE(offset + 32));
        assert(expectedFrames > 0, `${name}: video frames present`);
        await page.evaluate((name) => {
          const pointer = stringToNewUTF8(name);
          try {
            Module._WebTestNamedMovie(pointer);
          } finally {
            _free(pointer);
          }
        }, name);
        await page.waitForFunction(
          (name) =>
            tm4Port.movie.name === name && tm4Port.movie.playing && tm4Port.movie.frame >= 30,
          name,
          { timeout: 30000 },
        );
        await page.screenshot({ path: `build/checks/movie-${name.toLowerCase()}.png` });
        const audioBefore = await probe();
        await page.waitForFunction(() => tm4Port.movie.playing && tm4Port.movie.frame >= 60);
        const audioAfter = await probe();
        assert(audioAfter.nonzero > audioBefore.nonzero, `${name}: XA audio reaches SPU output`);
        await page.waitForFunction(() => !tm4Port.movie.active, null, { timeout: 240000 });
        await menu();
        const movie = await state();
        assert.equal(movie.name, name);
        assert.equal(movie.reason, "complete", `${name}: clean end of stream`);
        assert.equal(movie.frame, expectedFrames, `${name}: every original STR frame decoded`);
        assert.equal(movie.frames, expectedFrames, `${name}: registry frame count agrees with STR`);
        assert.deepEqual(errors, []);
        console.log("PASS complete movie and menu return", {
          name,
          frames: movie.frame,
          audioFrames: movie.audioFrames,
        });
      }
    }
    assert.deepEqual(errors, []);
  } catch (e) {
    console.error("STATE", await page.evaluate(() => tm4Port), "ERRORS", errors);
    await page.screenshot({ path: "build/checks/movie-failure.png" });
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
