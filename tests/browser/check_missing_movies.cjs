const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Fault injection only in this test: exercise the same rejected promise as a missing STR.
    await page.addInitScript(() => {
      let assets;
      Object.defineProperty(globalThis, "tm4Assets", {
        configurable: true,
        get: () => assets,
        set(value) {
          assets = value;
          assets.readMovie = (name) =>
            Promise.reject(new Error(`Optional movie ${name}.STR is unavailable`));
        },
      });
    });
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8121/");
    await page.waitForFunction(() => !document.getElementById("disc-folder").disabled);
    const directory = resolve(
      process.env.TM4_DISC_DIR || JSON.parse(readFileSync(".local/dev.json", "utf8")).discDirectory,
    );
    await page.locator("#disc-folder").setInputFiles(directory);
    await page.waitForFunction(
      () => globalThis.tm4Port?.screen === "main" && globalThis.tm4Port.menuReady,
      null,
      { timeout: 60000 },
    );
    const history = await page.evaluate(() => globalThis.tm4Port.movieHistory);
    for (const name of ["N89STUDI", "INTRO"]) {
      const movie = history.find((entry) => entry.name === name);
      assert(movie, `Missing completion callback for ${name}`);
      assert.equal(movie.reason, "load failed");
      assert.equal(movie.active, false);
    }
    assert.equal(await page.locator("#tm4-movie-start").count(), 0);
    assert(await page.locator("#startup").isHidden());
    assert.deepEqual(errors, []);
    console.log(
      "PASS: both missing startup STR movies finish cleanly and the main menu loads without a runtime crash",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
