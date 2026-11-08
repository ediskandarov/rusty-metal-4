const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { resolve, join } = require("node:path");

(async () => {
  const directory = resolve(
    process.env.TM4_DISC_DIR || JSON.parse(readFileSync(".local/dev.json", "utf8")).discDirectory,
  );
  const files = readdirSync(directory)
    .filter((name) => /\.(cue|bin)$/i.test(name))
    .map((name) => join(directory, name));
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8121/");
    assert(await page.locator("#startup").isVisible(), "public build starts with a file picker");
    assert(
      !requests.some((path) => path.startsWith("/__dev/")),
      "public build never downloads a local disc",
    );
    assert(!requests.includes("/tm4_web.wasm"), "WASM waits until the disc is verified");
    await page.locator("#disc-files").setInputFiles({
      name: "bad.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(2352),
    });
    await page.waitForFunction(() =>
      document.getElementById("startup-progress").textContent.includes("outside disc file"),
    );
    assert(
      await page.locator("#disc-files").isEnabled(),
      "bad input can be replaced without reloading",
    );
    await page.locator("#disc-files").setInputFiles(files);
    await require("./browser_startup.cjs")(page);
    assert(await page.locator("#startup").isHidden());
    assert(
      !requests.some(
        (path) => path.startsWith("/__dev/") || /\.(bin|cue|pcm|STR|data)$/i.test(path),
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS public file picker, invalid-input recovery, local extraction, movies and menu; no resource downloads",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
