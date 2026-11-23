import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const url = process.env.TM4_CHALLENGE_URL || "http://127.0.0.1:8362/200-challenge";
assert(
  ["127.0.0.1", "localhost"].includes(new URL(url).hostname),
  "Trusted score fixtures run only against a local service",
);
await page.goto(url);
await page.waitForFunction(() => !document.querySelector("#challenge-launch").disabled);
await page.locator("#challenge-name").fill("Local challenge driver");
await page.locator("#challenge-name-form button").click();
await page.getByText("Local challenge driver: 0 cars mastered.", { exact: true }).waitFor();
await page.locator("#challenge-launch").click();
const frame = page.frameLocator("#challenge-player");
await frame.locator("#disc-folder").waitFor();
assert.match(await frame.locator("body").innerText(), /disc|folder|Select/i);
const child = page.frames().find((f) => f.url().includes("/challenge-releases/"));
assert(child);
let run = 0;
async function finish(status, map, frags, expected) {
  await child.evaluate(
    (challenge) =>
      window.parent.postMessage({ type: "tm4:200-challenge", challenge }, location.origin),
    { version: "200-v1", runId: String(++run), status, model: "Orbital", map, frags, cars: 1 },
  );
  await page.locator("#challenge-game-status").filter({ hasText: expected }).waitFor();
}
await finish("won", "Construction Yard", 35, "Total score: 35 (+35)");
await finish("won", "The Carnival", 42, "Total score: 42 (+7)");
await finish("lost", "Construction Yard", 80, "Run not counted");
await finish("won", "Construction Yard", 30, "Total score: 42 (+0)");
await page.reload();
await page.getByText("Local challenge driver: 1 car mastered.", { exact: true }).waitFor();
const row = page.locator("#challenge-board tr").filter({ hasText: "Local challenge driver" });
assert.deepEqual(await row.locator("td").allTextContents(), ["1", "42"]);
const driver = row.getByRole("button", { name: "Local challenge driver" });
await driver.focus();
await page.keyboard.press("Enter");
const dialog = page.getByRole("dialog", { name: "Local challenge driver" });
await dialog.waitFor();
const record = dialog.getByRole("row").filter({ hasText: "Orbital" });
assert.match(await record.innerText(), /Orbital\s+42\s+The Carnival\s+\d{4}-/);
await page.keyboard.press("Escape");
assert(await driver.evaluate((el) => el === document.activeElement));
await page.setViewportSize({ width: 390, height: 844 });
await driver.click();
await dialog.getByRole("button", { name: "Close" }).click();
assert(await dialog.isHidden());
assert.deepEqual(errors, []);
console.log("PASS challenge scoring, repeat wins, losses, persistence and driver records dialog");
await browser.close();
