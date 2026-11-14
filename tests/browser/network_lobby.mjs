import { readFile } from "node:fs/promises";

// Select the fixture roster through the same lobby used by a player.
async function readyInLobby(page) {
  await page.waitForFunction(
    () =>
      !document.getElementById("car-lobby").hidden ||
      document.getElementById("status").dataset.matchState === "error",
    null,
    { timeout: 60000 },
  );
  if (!(await page.locator("#car-lobby").isVisible()))
    throw new Error("Lobby unavailable: " + (await page.locator("#status").innerText()));
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

// Use the authenticated production Leave request; no synthetic round-completion rule.
async function leaveMatch(page) {
  await page.evaluate(async () => {
    const { NetworkClient } = await import(
      new URL("network/tm4_network.js", document.baseURI).href
    );
    const update = NetworkClient.prototype.update;
    let sent = false;
    NetworkClient.prototype.update = function () {
      if (!sent && this.connected()) {
        sent = true;
        this.send(JSON.stringify({ type: "leave" }));
        globalThis.tm4TestLeaveSent = true;
      }
      return update.call(this);
    };
  });
  await page.waitForFunction(() => globalThis.tm4TestLeaveSent);
}

export { readyInLobby, leaveMatch };
