const { waitForPlayer } = require("./helpers/player.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");

(async () => {
  const directory = resolve(
    process.env.TM4_DISC_DIR || JSON.parse(readFileSync(".local/dev.json", "utf8")).discDirectory,
  );
  const browser = await launchBrowser();
  const invalidDirectory = await mkdtemp(join(tmpdir(), "tm4-invalid-disc-"));
  try {
    await writeFile(join(invalidDirectory, "bad.bin"), Buffer.alloc(2352));
    const page = await browser.newPage();
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8121/");
    assert(await page.locator("#startup").isVisible(), "public build starts with a folder picker");
    assert(
      !requests.some((path) => path.startsWith("/__dev/")),
      "public build never downloads a local disc",
    );
    assert(!requests.includes("/tm4_web.wasm"), "WASM waits until the disc is verified");
    assert.equal(await page.locator("#disc-files").count(), 0);
    await page.locator("#disc-folder").setInputFiles(invalidDirectory);
    await page.waitForFunction(() =>
      document.getElementById("startup-progress").textContent.includes("outside disc file"),
    );
    assert(
      await page.locator("#disc-folder").isEnabled(),
      "bad input can be replaced without reloading",
    );
    await page.locator("#disc-folder").setInputFiles(directory);
    await waitForPlayer(page);
    assert(await page.locator("#startup").isHidden());
    assert(await page.locator("#disc-folder").isDisabled());

    assert(
      !requests.some(
        (path) => path.startsWith("/__dev/") || /\.(bin|cue|pcm|STR|data)$/i.test(path),
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS public disc selection, invalid-input recovery, local extraction, runtime startup; no resource downloads",
    );
  } finally {
    await browser.close();
    await rm(invalidDirectory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
