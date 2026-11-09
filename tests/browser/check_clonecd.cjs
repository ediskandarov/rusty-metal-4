const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createReadStream, readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { chromium } = require("playwright");

(async () => {
  if (!process.env.TM4_CLONECD_DIR) throw new Error("Set TM4_CLONECD_DIR to a CloneCD disc folder");
  const directory = resolve(process.env.TM4_CLONECD_DIR);
  const image = readdirSync(directory).find((name) => /\.img$/i.test(name));
  assert(image, "IMG is required");
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
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8121/");
    await page.waitForFunction(() => !document.getElementById("disc-folder").disabled);
    await page.locator("#disc-folder").setInputFiles(directory);
    await require("./browser_startup.cjs")(page);
    await page.waitForFunction(
      () =>
        document.getElementById("resource-check").disabled &&
        document.getElementById("resource-summary").textContent.includes("checked"),
      null,
      { timeout: 90000 },
    );
    assert.equal(await page.locator('.resource-row[data-status="uncompatible"]').count(), 0);
    console.log(await page.locator("#resource-summary").textContent());
    const tracks = await page.evaluate(async () => {
      const result = [];
      for (const track of globalThis.tm4Assets.tracks.filter((track) => track.audio)) {
        const bytes = await globalThis.tm4Assets.readAudio(track.number);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        result.push({
          number: track.number,
          start: track.start,
          end: track.end,
          size: bytes.length,
          hash: [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        });
      }
      return result;
    });
    assert.equal(tracks.length, 22);
    for (const track of tracks) {
      assert.equal(track.size, (track.end - track.start) * 2352);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(join(directory, image), {
        start: track.start * 2352,
        end: track.end * 2352 - 1,
      }))
        hash.update(chunk);
      assert.equal(track.hash, hash.digest("hex"));
    }
    await page.locator("canvas").click();
    for (const screen of ["newgame", "carsel"]) {
      await page.keyboard.press("x", { delay: 150 });
      await page.waitForFunction(
        (name) => globalThis.tm4Port?.screen === name && globalThis.tm4Port.menuReady,
        screen,
        { timeout: 30000 },
      );
    }
    await page.keyboard.press("d", { delay: 150 });
    await page.waitForFunction(
      () =>
        globalThis.tm4Port?.music?.track === 13 &&
        globalThis.tm4Port.music.ready &&
        globalThis.tm4Port.music.nonzero > 0,
      null,
      { timeout: 30000 },
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: "build/checks/clonecd-menu.png" });
    console.log(
      "PASS: CloneCD folder starts movies and menu; 22 audio slices verified; biography audio plays",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
