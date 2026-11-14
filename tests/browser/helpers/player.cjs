const assert = require("node:assert/strict");

async function waitForPlayer(page) {
  // These controls are enabled by runtime initialization in dev and release too.
  await page.locator("#input-settings").waitFor({ state: "attached" });
  await page.waitForFunction(() => !document.querySelector("#input-settings").hidden, null, {
    timeout: 90000,
  });
}

async function setPanelOpen(page, id, open) {
  const panel = page.locator("#" + id);
  if ((await panel.evaluate((node) => node.open)) === open) return;
  if (await page.locator("#settings-menu").isHidden())
    await page.locator("#settings-toggle").click();
  await panel.locator(":scope > summary").click();
  assert.equal(await panel.evaluate((node) => node.open), open, id + " open state");
}

async function togglePanel(page, id) {
  await setPanelOpen(page, id, !(await page.locator("#" + id).evaluate((node) => node.open)));
}

async function closeSettings(page) {
  if (await page.locator("#settings-menu").isVisible())
    await page.locator("#settings-toggle").click();
  await page.locator("canvas").focus();
}

async function startDiagnosticGame(page) {
  if (process.env.TM4_DISC_DIR && (await page.locator("#disc-folder").isEnabled()))
    await page.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
  await waitForPlayer(page);
  assert(
    await page.evaluate(() => typeof globalThis.Module?._WebTestGetPadButtons === "function"),
    "This scenario requires a diagnostic runtime. Build with bun run build:diagnostic and point TM4_WEB_URL at that site. UI-only checks use test:player instead.",
  );
  await closeSettings(page);
  // Exercise normal startup: studio is unskippable, Start skips only the intro.
  await page.waitForFunction(() => globalThis.tm4Port?.movie, null, { timeout: 30000 });
  const start = page.locator("#tm4-movie-start");
  if (await start.count()) await start.click();
  else await page.locator("canvas").click();
  await page.waitForFunction(() => globalThis.tm4Port.movie.name === "INTRO", null, {
    timeout: 30000,
  });
  await page.keyboard.press("Enter", { delay: 120 });
  await page.waitForFunction(
    () => globalThis.tm4Port.screen === "main" && globalThis.tm4Port.menuReady,
    null,
    { timeout: 30000 },
  );
}

module.exports = { waitForPlayer, setPanelOpen, togglePanel, closeSettings, startDiagnosticGame };
