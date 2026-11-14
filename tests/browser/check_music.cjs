/* global tm4Port, musicProbe, Module */
/* Verify the original Redbook callers through real menu input and the SPU output. */
const { startDiagnosticGame } = require("./helpers/player.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(String(e));
    console.error(e);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/^\[[ID]\]/.test(m.text())) {
      errors.push(m.text());
      console.error(m.text());
    }
  });
  const press = async (key) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
    await page.waitForTimeout(150);
  };
  const screen = async (name) =>
    page.waitForFunction((name) => globalThis.tm4Port?.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  await require("./browser_diagnostics.cjs")(page);
  const music = () => page.evaluate(() => tm4Port.music);
  const waitMusic = (track) =>
    page.waitForFunction(
      (track) =>
        tm4Port.music?.track === track &&
        tm4Port.music.ready &&
        !tm4Port.music.muted &&
        tm4Port.music.nonzero > 0,
      track,
      { timeout: 30000 },
    );
  const measure = async () => {
    await page.evaluate(() => {
      globalThis.musicProbe = { peak: 0, nonzero: 0, buffers: 0 };
    });
    await page.waitForTimeout(800);
    return page.evaluate(() => musicProbe);
  };
  try {
    await page.goto("http://127.0.0.1:8080/");
    await startDiagnosticGame(page);
    await screen("main");
    await page.locator("canvas").click();
    await page.evaluate(() => {
      const node = Module.SDL3.audio_playback.scriptProcessorNode,
        render = node.onaudioprocess;
      globalThis.musicProbe = { peak: 0, nonzero: 0, buffers: 0 };
      node.onaudioprocess = (event) => {
        render(event);
        musicProbe.buffers++;
        for (let c = 0; c < event.outputBuffer.numberOfChannels; c++)
          for (const value of event.outputBuffer.getChannelData(c)) {
            musicProbe.peak = Math.max(musicProbe.peak, Math.abs(value));
            musicProbe.nonzero += value !== 0;
          }
      };
    });
    await press("x");
    await screen("newgame");
    await press("x");
    await screen("carsel");
    await press("d");
    await waitMusic(13);
    console.log("Orbital biography", await music());
    if (process.env.TM4_TEST_MUSIC_END) {
      assert.equal(await page.evaluate(() => Module._WebTestMusicNearEnd()), 1);
      await page.waitForFunction(() => tm4Port.music.sector > 290700);
      await page.waitForFunction(() => tm4Port.music.muted && tm4Port.music.sector < 290300, null, {
        timeout: 10000,
      });
      const finished = await music();
      await page.waitForTimeout(600);
      assert.equal(
        (await music()).nonzero,
        finished.nonzero,
        "original biography completion must leave CD silent",
      );
      console.log("Biography completion", await music());
    }
    await press("s");
    await screen("carsel");
    assert.equal((await music()).playing, false);
    await press("x");
    await page.waitForFunction(() => tm4Port.carTicks > 30, null, { timeout: 30000 });
    await waitMusic(2);
    console.log("Construction Yard", await music());
    if (process.env.TM4_TEST_MUSIC_END) {
      const start = await music();
      assert.equal(await page.evaluate(() => Module._WebTestMusicNearEnd()), 1);
      await page.waitForFunction(() => tm4Port.music.sector > 180000);
      await page.waitForFunction(
        () => tm4Port.music.track === 2 && tm4Port.music.sector < 164000 && !tm4Port.music.muted,
        null,
        { timeout: 10000 },
      );
      const repeated = await music();
      assert(repeated.frames > start.frames);
      console.log("Original Redbook repeat", repeated);
    }
    await press("Enter");
    await page.waitForFunction(() => tm4Port.paused && !tm4Port.music.playing);
    const stopped = await music();
    await page.waitForTimeout(600);
    assert.equal((await music()).frames, stopped.frames);
    // Skip SPLIT in single player: CAMERA, SOUND, MUSIC.
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    await waitMusic(2);
    await page.waitForTimeout(600);
    const loud = await measure();
    assert(loud.nonzero > 0, "CD music reaches SPU output while gameplay is paused");
    await page.keyboard.down("ArrowLeft");
    await page.waitForTimeout(1500);
    await page.keyboard.up("ArrowLeft");
    await page.waitForTimeout(600);
    const silent = await measure();
    assert(
      silent.peak < 0.0001,
      `music volume zero must silence paused output: ${JSON.stringify(silent)}`,
    );
    const silentState = await music();
    await page.waitForTimeout(300);
    assert((await music()).frames > silentState.frames, "volume zero must not stop CD playback");
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(1500);
    await page.keyboard.up("ArrowRight");
    await page.waitForTimeout(600);
    const restored = await measure();
    assert(restored.nonzero > 0);
    console.log("Volume through SPU", { loud, silent, restored });
    // MUSIC -> SOUND -> CAMERA -> RESUME.
    await press("ArrowUp");
    await press("ArrowUp");
    await press("ArrowUp");
    await press("x");
    await page.waitForFunction(() => !tm4Port.paused && tm4Port.music.playing);
    await press("Enter");
    await page.waitForFunction(() => tm4Port.paused);
    await press("ArrowUp");
    await press("x");
    await press("ArrowUp");
    await press("x");
    await screen("main");
    assert.equal((await music()).playing, false);
    await press("x");
    await screen("newgame");
    await press("ArrowRight");
    await press("x");
    await screen("dmatch");
    await press("ArrowRight");
    await press("x");
    await screen("carsel");
    await press("x");
    await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 30, null, {
      timeout: 30000,
    });
    await waitMusic(3);
    console.log("Neon City", await music());
    assert.deepEqual(errors, []);
    console.log(
      "PASS biography, world tracks, pause/resume, original music volume through SPU, quit and next world",
    );
  } catch (e) {
    console.log("STATE", await page.evaluate(() => globalThis.tm4Port));
    await page.screenshot({ path: "build/checks/music-failure.png" });
    throw e;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
