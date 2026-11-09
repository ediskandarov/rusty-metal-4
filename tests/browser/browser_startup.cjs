const { mkdirSync } = require("node:fs");
mkdirSync("build/checks", { recursive: true });
/* global tm4Port */
/* Exercise normal startup: studio is unskippable, Start skips only the intro. */
module.exports = async function startup(page) {
  await page.waitForFunction(() => globalThis.tm4Port?.movie, null, { timeout: 30000 });
  const resources = page.locator("#resources");
  if ((await resources.count()) && (await resources.evaluate((node) => node.open)))
    await resources.locator(":scope > summary").click();
  const start = page.locator("#tm4-movie-start");
  if (await start.count()) await start.click();
  else await page.locator("canvas").click();
  await page.waitForFunction(() => tm4Port.movie.name === "INTRO", null, { timeout: 30000 });
  await page.keyboard.down("Enter");
  await page.waitForTimeout(120);
  await page.keyboard.up("Enter");
  await page.waitForFunction(() => tm4Port.screen === "main" && tm4Port.menuReady, null, {
    timeout: 30000,
  });
};
