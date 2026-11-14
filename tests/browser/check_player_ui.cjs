const assert = require("node:assert/strict");
const { launchBrowser } = require("./helpers/browser.cjs");
const { waitForPlayer, setPanelOpen, closeSettings } = require("./helpers/player.cjs");

// Exercise the real player and Wasm through its public UI on either dev or release.
// Gameplay assertions using WebTest exports belong in the diagnostic scenarios.
(async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const ready = async () => {
      if (process.env.TM4_DISC_DIR) {
        await page.waitForFunction(() => !document.querySelector("#disc-folder").disabled);
        await page.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
      }
      await waitForPlayer(page);
      await page.locator("#startup").waitFor({ state: "hidden", timeout: 90000 });
    };
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
    await ready();
    assert(await page.locator("#settings-menu").isHidden());
    assert.equal(await page.locator("#settings-toggle").getAttribute("aria-expanded"), "false");
    const canvas = await page.locator("canvas").boundingBox();
    await setPanelOpen(page, "render-settings", true);
    assert.deepEqual(await page.locator("canvas").boundingBox(), canvas);
    assert.equal(await page.locator("#render-preset").inputValue(), "ultra");
    await page.locator("#render-preset").selectOption("ps1");
    assert.equal(await page.locator("#render-scale").inputValue(), "1");
    assert.equal(await page.locator("#render-limit").inputValue(), "30");
    assert.equal(await page.locator("#render-smoothing").isChecked(), false);
    assert(await page.locator("#render-smoothing-delay").isDisabled());
    await page.locator("#render-limit").selectOption("60");
    assert.equal(await page.locator("#render-preset").inputValue(), "custom");
    await page.locator("#render-reset").click();
    assert.equal(await page.locator("#render-preset").inputValue(), "ultra");
    assert.equal(await page.locator("#render-limit").inputValue(), "120");
    await page.locator("#render-smoothing-delay").press("ArrowLeft");
    assert.equal(await page.locator("#render-smoothing-delay").inputValue(), "6");
    assert.equal(await page.locator("#render-preset").inputValue(), "custom");

    const key = (name) => page.getByRole("button", { name: new RegExp(`^Change ${name} key,`) });
    await setPanelOpen(page, "input-settings", true);
    assert.equal(await page.locator("#render-settings").evaluate((el) => el.open), false);
    await key("Cross").click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#input-settings").evaluate((el) => el.open), true);
    assert(await page.locator("#input-capture").isHidden());
    await key("Cross").click();
    await page.keyboard.press("z");
    assert.equal(await key("Cross").textContent(), "Z");
    assert.equal(await key("Square").textContent(), "X");
    await page.locator("#input-close").click();
    await closeSettings(page);
    await page.reload();
    await ready();
    await setPanelOpen(page, "input-settings", true);
    assert.equal(await key("Cross").textContent(), "Z");
    assert.equal(await key("Square").textContent(), "X");
    await page.locator("#input-reset").click();
    assert.equal(await key("Cross").textContent(), "X");
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Denied", "SecurityError");
      };
    });
    await key("Cross").click();
    await page.keyboard.press("c");
    assert.equal(await key("Cross").textContent(), "C");
    assert.match(
      await page.locator("#input-message").textContent(),
      /Browser storage is unavailable/,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of ["render-settings", "input-settings", "resources", "mods", "troubleshoot"]) {
      await setPanelOpen(page, id, true);
      const panel = page.locator(`#${id} > .settings-panel`);
      await page.waitForFunction((id) => {
        const panel = document.querySelector(`#${id} > .settings-panel`);
        const bounds = panel.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight - 11;
      }, id);
      assert(await panel.isVisible());
      await page.screenshot({ path: `build/checks/player-${id}-mobile.png` });
    }
    await page.locator("#troubleshoot > summary").focus();
    await page.keyboard.press("Escape");
    assert(await page.locator("#settings-menu").isHidden());
    assert.equal(await page.evaluate(() => document.activeElement.id), "canvas");
    await setPanelOpen(page, "render-settings", true);
    await page.locator("canvas").click({ position: { x: 10, y: 500 } });
    assert(await page.locator("#settings-menu").isHidden());
    assert.deepEqual(errors, []);
    console.log(
      "PASS player UI: gear, presets, capture, persistence, denied storage, panels and mobile layout",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
