import { readFile } from "node:fs/promises";

// Select the fixture roster through the same lobby used by a player.
async function readyInLobby(page) {
  await page.locator("#car-lobby").waitFor({ state: "visible", timeout: 60000 });
  const slot =
    Number((await page.locator("#car-lobby-player").innerText()).replace("Player ", "")) - 1;
  const fixture = process.env.TM4_TEST_ACTIONS
    ? JSON.parse(await readFile(process.env.TM4_TEST_ACTIONS, "utf8"))
    : {};
  const cars = fixture.cars ?? process.env.TM4_MATCH_CARS?.split(",");
  if (cars?.[slot]) await page.locator("#car-choice").selectOption(cars[slot]);
  await page.waitForFunction(() => !document.getElementById("car-ready").disabled);
  await page
    .locator("#car-ready")
    .filter({ hasText: /^Ready$/ })
    .click();
}

export { readyInLobby };
