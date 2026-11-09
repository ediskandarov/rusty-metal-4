const assert = require("node:assert/strict");
const { readdirSync, readFileSync, mkdirSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    mkdirSync("build/checks", { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8121/");
    await page.waitForFunction(() => !document.getElementById("disc-files").disabled);
    const variant = process.env.TM4_VARIANT_DISC_DIR;
    if (variant) {
      await page.locator("#disc-folder").setInputFiles(resolve(variant));
      await page.waitForFunction(
        () =>
          document.getElementById("resource-summary").textContent.includes("checked") &&
          document.getElementById("resource-check").disabled,
        null,
        { timeout: 90000 },
      );
      assert(await page.locator("#startup").isVisible());
      assert(await page.locator("#disc-files").isEnabled());
      const summary = await page.locator("#resource-summary").textContent();
      console.log("Variant:", summary);
      assert(await page.locator('.resource-row[data-status="modified"]').count());
      assert(await page.locator('.resource-row[data-status="error"]').count());
      await page.locator("#resource-issues").check();
      assert.equal(await page.locator('.resource-row[data-status="original"]:visible').count(), 0);
      await page.locator("#resource-search").fill("CADCOP");
      assert.equal(await page.locator(".resource-row:visible").count(), 1);
      await page.locator(".resource-row:visible > summary").click();
      assert.match(
        await page.locator(".resource-row:visible pre").textContent(),
        /Invalid Mode 2 Form 1/,
      );
      await page.screenshot({ path: "build/checks/resources-variant.png" });
    }
    const directory = resolve(
      process.env.TM4_DISC_DIR || JSON.parse(readFileSync(".local/dev.json", "utf8")).discDirectory,
    );
    const files = readdirSync(directory)
      .filter((name) => /\.(cue|bin)$/i.test(name))
      .map((name) => join(directory, name));
    await page.locator("#disc-files").setInputFiles(files);
    await page.waitForFunction(
      () =>
        document.getElementById("resource-check").textContent === "Pause checks" &&
        !document.getElementById("resource-check").disabled,
    );
    await page.locator("#resource-check").click();
    await page.waitForFunction(
      () => document.getElementById("resource-check").textContent === "Continue checks",
    );
    assert.equal(await page.locator('.resource-row[data-status="checking"]').count(), 0);
    await page.locator("#resource-check").click();
    await page.waitForFunction(
      () =>
        document.getElementById("resource-summary").textContent.startsWith("275 original") &&
        document.getElementById("resource-check").disabled,
      null,
      { timeout: 90000 },
    );
    assert.equal(await page.locator('.resource-row[data-status="original"]').count(), 275);
    await page.locator("#resource-search").fill("neon");
    assert(await page.locator(".resource-row:visible").count());
    await page.locator("#resource-search").fill("");
    await page.screenshot({ path: "build/checks/resources-original.png" });
    // The sidebar is an overlay: opening/closing it never changes the game viewport.
    const canvas = await page.locator("canvas").boundingBox();
    await page.locator("#resources > summary").click();
    assert.deepEqual(await page.locator("canvas").boundingBox(), canvas);
    await require("./browser_startup.cjs")(page);
    assert(await page.locator("#startup").isHidden());
    assert(await page.locator("#resources").isVisible());
    await page.locator("#resources > summary").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "build/checks/resources-mobile.png" });
    const bounds = await page.locator("#resources").boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.deepEqual(errors, []);
    console.log(
      "PASS resource inventory, SHA-256 identity, pause/resume, filters, retry, viewport and normal game startup",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
