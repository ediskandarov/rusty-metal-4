/* global Module, tm4Port */
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { staticFile } from "../../tools/server/files.js";
import { launchBrowser } from "./helpers/browser.mjs";

const { TM3_DISC, TM4_DISC } = process.env;
if (!TM3_DISC || !TM4_DISC) throw Error("Set TM3_DISC and TM4_DISC to disc folders");
const site = resolve(process.env.TM4_MODS_SITE ?? "build/release/rustymetal4.com-site");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = await staticFile(site, path.endsWith("/") ? path + "index.html" : path);
    if (!file || !(await file.exists())) return new Response(null, { status: 404 });
    return new Response(file, {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    });
  },
});

async function playStartupMovies(page) {
  await page.waitForFunction(() => globalThis.tm4Port?.movie?.name === "N89STUDI");
  const start = page.locator("#tm4-movie-start");
  if (await start.count()) await start.click();
  else await page.locator("canvas").click();
  await page.waitForFunction(
    () => tm4Port.movie?.name === "INTRO" && tm4Port.movie.frame >= 4,
    null,
    { timeout: 60_000 },
  );
  assert.equal(await page.evaluate(() => tm4Port.movieHistory[0]?.reason), "complete");
  await page.keyboard.press("Enter", { delay: 150 });
  await page.waitForFunction(() => tm4Port.screen === "main" && tm4Port.menuReady, null, {
    timeout: 30_000,
  });
  assert.equal(await page.evaluate(() => tm4Port.movie.reason), "skipped");
}

let browser;
try {
  browser = await launchBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  if (process.env.TM4_MOD_TEST_LOG)
    page.on("console", (message) => {
      if (!message.text().startsWith("performance warning")) console.log(message.text());
    });
  page.on("pageerror", (error) => errors.push(error.message));
  const library = await context.newPage();
  await library.goto(new URL("mods/", server.url).href);
  await library.locator("#mod-import:enabled").waitFor();
  await page.bringToFront();
  await page.goto(new URL("mods/tm3/", server.url).href);
  await page.locator("#build-mod:enabled").waitFor();
  await page.locator("#tm3-disc").setInputFiles(TM3_DISC);
  await page.locator("#tm4-disc").setInputFiles(TM4_DISC);
  await page.getByRole("button", { name: "Build and enable" }).click();
  await page.locator("#mod-play:not([hidden]), #mod-build-error:not([hidden])").first().waitFor({
    timeout: 120_000,
  });
  assert.equal(await page.locator("#mod-build-error").textContent(), "");
  assert.equal(await page.locator("#mod-build-status").textContent(), "TM3 installed and enabled.");

  // An already open library must observe the installation in the other tab.
  await library.bringToFront();
  await library.getByRole("button", { name: "Disable" }).waitFor();
  await library.reload();
  await library.getByRole("button", { name: "Disable" }).waitFor();
  assert.match(await library.locator("#mod-library").textContent(), /TM3.*Enabled/s);
  await library.getByRole("button", { name: "Disable" }).click();
  await library.getByRole("button", { name: "Enable", exact: true }).click();
  await library.getByRole("button", { name: "Disable" }).waitFor();

  await page.bringToFront();
  let buildRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/play/simulation-build.json") buildRequests++;
  });
  await page.getByRole("link", { name: "Play with TM3" }).click();
  await page.locator("#disc-folder:enabled").waitFor({ state: "attached" });
  await page.locator("#disc-folder").setInputFiles(TM4_DISC);
  try {
    await page.locator("#startup").waitFor({ state: "hidden", timeout: 90_000 });
    await page.locator("#video-controls").waitFor({ timeout: 30_000 });
  } catch (error) {
    throw Error((await page.locator("#startup-progress").textContent()) || errors.join("\n"), {
      cause: error,
    });
  }
  assert.match(await page.locator("#active-mods").textContent(), /TM3/);
  assert.equal(buildRequests, 1);
  assert.deepEqual(errors, []);
  const paths = await page.evaluate(() => {
    const fs = globalThis.Module.FS;
    return fs.readdir("/DATA").filter((name) => /^MTM3.*\.MR$|^TM3MAP.*\.IMG$/.test(name));
  });
  assert.equal(paths.filter((name) => name.endsWith(".MR")).length, 16);
  assert.equal(paths.filter((name) => name.endsWith(".IMG")).length, 10);
  const state = () => page.evaluate(() => globalThis.tm4Port);
  const screen = (name) =>
    page.waitForFunction(
      (name) => globalThis.tm4Port?.screen === name && globalThis.tm4Port.menuReady,
      name,
      { timeout: 60_000 },
    );
  async function press(key) {
    await page.keyboard.press(key, { delay: 150 });
    const frame = (await state()).frames;
    await page.waitForFunction((frame) => {
      const port = globalThis.tm4Port;
      return !port.menuReady || port.frames >= frame + 2;
    }, frame);
  }
  async function choose(field, name) {
    const visited = new Set();
    while (true) {
      const previous = (await state())[field];
      if (previous === name) return;
      assert(!visited.has(previous), `Missing ${name} from ${field}`);
      visited.add(previous);
      await press("ArrowRight");
      await page.waitForFunction(
        ({ field, previous }) =>
          globalThis.tm4Port[field] !== previous && globalThis.tm4Port.menuReady,
        { field, previous },
      );
    }
  }

  await playStartupMovies(page);
  assert.deepEqual(errors, []);
  console.log("PASS installed TM3 reached the main menu after playing and skipping intro movies");
  await page.locator("canvas").focus();
  await press("x");
  await screen("newgame");
  if ((await state()).gameType !== 1) await press("ArrowRight");
  await press("x");
  await screen("dmatch");
  await choose("selectedWorld", "Hollywood");
  console.log("PASS native menu selected Hollywood");
  await press("x");
  await screen("carsel");
  await choose("selectedCar", "mtm3sw");
  // D is Circle (Info). The car has no info image, so the shortcut stays in the picker.
  await press("d");
  assert.equal((await state()).screen, "carsel");
  console.log("PASS native menu selected TM3 Sweet Tooth");
  await press("x");
  await page.waitForFunction(() => {
    const port = globalThis.tm4Port;
    return port?.level === "Hollywood" && port.levelFrames >= 30;
  });
  assert.equal((await state()).music.track, 0);
  await press("Enter");
  await page.waitForFunction(() => tm4Port.paused, null, { timeout: 10_000 });
  const pausedFrame = (await state()).levelFrames;
  await press("x");
  await page.waitForFunction(
    (frame) => !tm4Port.paused && tm4Port.levelFrames >= frame + 15,
    pausedFrame,
    { timeout: 10_000 },
  );
  const { track, playing } = (await state()).music;
  assert.equal(track, 0);
  assert.equal(playing, false);
  console.log("PASS Hollywood starts and resumes without a CD track");
  assert.deepEqual(errors, []);
  console.log(
    "PASS TM3 disc conversion, persistence, and gameplay through the native car/map menus",
  );
  if (process.env.TM4_MOD_TEST_SAVES === "1") {
    async function openMenu() {
      await page.reload();
      await page.locator("#disc-folder:enabled").setInputFiles(TM4_DISC);
      await playStartupMovies(page);
      await page.locator("canvas").focus();
    }

    const matchState = () =>
      page.evaluate(() => {
        Module._WebTestReadMatchState();
        return tm4Port;
      });
    for (const car of ["mtm3sw", "mtm3fp"]) {
      await page.evaluate(() => localStorage.removeItem("tm4.memory-card.0"));
      await openMenu();
      await press("x");
      await screen("newgame");
      await press("x");
      await screen("carsel");
      await choose("selectedCar", car);
      await press("x");
      await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames >= 30);
      assert.equal((await matchState()).car, car);
      const deadline = Date.now() + 60_000;
      while (!(await matchState()).match.acceptsInput && Date.now() < deadline) {
        await page.evaluate(() => Module._WebTestDefeatOpponents());
        await page.waitForTimeout(500);
      }
      assert.equal((await matchState()).match.acceptsInput, 1);
      await press("z");
      await screen("tsave");
      await press("x");
      await page.waitForFunction(() => tm4Port.dialog === "SAVE COMPLETE!\nCONTINUE?");
      const card = await page.evaluate(() => localStorage.getItem("tm4.memory-card.0"));
      assert(card && Buffer.from(card, "base64").includes(Buffer.from(car + "\0")));
      await press("x");
      await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames >= 30);
      const saved = await matchState();

      await openMenu();
      await press("ArrowDown");
      await press("x");
      await screen("tload");
      await press("x");
      await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames >= 30);
      const loaded = await matchState();
      assert.equal(loaded.car, car);
      assert.equal(loaded.level, saved.level);
      assert.equal(loaded.match.progress, saved.match.progress);
      assert.equal(loaded.match.lives, saved.match.lives);
      assert.deepEqual(errors, []);
      console.log("PASS tournament save and load preserve", car, loaded.level);
    }
  }

  await page.close();
  await library.close();

  const unapproved = await context.newPage();
  await unapproved.bringToFront();
  // With the reviewed converter pin absent, previously installed code must fail closed.
  await unapproved.route("**/mod-converters/tm3/pin.json", (route) =>
    route.fulfill({ status: 404 }),
  );
  await unapproved.goto(new URL("play/", server.url).href);
  await unapproved.locator("#disc-folder:enabled").setInputFiles(TM4_DISC);
  await unapproved.getByText(/Resource module mtm3fx\.sym is not approved/).waitFor({
    timeout: 90_000,
  });
  await unapproved.close();
  console.log("PASS the runtime refuses a resource module outside the current approval list");

  const stock = await context.newPage();
  await stock.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException("Storage blocked", "SecurityError");
    };
  });
  await stock.bringToFront();
  await stock.goto(new URL("play/", server.url).href);
  const disc = stock.locator("#disc-folder:enabled");
  await disc.setInputFiles(TM4_DISC);
  await stock.getByText("Storage blocked").waitFor();
  await stock.getByRole("checkbox", { name: "Play without mods" }).check();
  await disc.setInputFiles(TM4_DISC);
  await stock.locator("#startup").waitFor({ state: "hidden", timeout: 90_000 });
  await stock.locator("#video-controls").waitFor({ timeout: 30_000 });
  assert.equal(await stock.locator("#active-mods").textContent(), "No active mods.");
  await playStartupMovies(stock);
  console.log("PASS Play Disk works with the same disc when mod storage is blocked");
} finally {
  await browser?.close();
  server.stop(true);
}
