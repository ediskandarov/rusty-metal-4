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
await page.getByText("Local challenge driver: 0 models completed.", { exact: true }).waitFor();
await page.locator("#challenge-launch").click();
const frame = page.frameLocator("#challenge-player");
await frame.locator("#disc-folder").waitFor();
assert.match(await frame.locator("body").innerText(), /disc|folder|Select/i);
const child = page.frames().find((f) => f.url().includes("/challenge-releases/"));
assert(child);
await child.evaluate(() =>
  window.parent.postMessage(
    {
      type: "tm4:200-challenge",
      challenge: {
        version: "200-v1",
        status: "won",
        model: "Orbital",
        map: "Construction Yard",
        cars: 1,
      },
    },
    location.origin,
  ),
);
await page.getByText("Orbital completed! Your score is 1.", { exact: true }).waitFor();
await child.evaluate(() =>
  window.parent.postMessage(
    {
      type: "tm4:200-challenge",
      challenge: {
        version: "200-v1",
        status: "won",
        model: "Orbital",
        map: "The Carnival",
        cars: 1,
      },
    },
    location.origin,
  ),
);
await page.waitForTimeout(200);
assert.equal(
  await page.locator("#challenge-profile").innerText(),
  "Local challenge driver: 1 models completed.",
);
await page.reload();
await page.getByText("Local challenge driver: 1 models completed.", { exact: true }).waitFor();
assert.deepEqual(errors, []);
await page.screenshot({ path: "build/checks/challenge-page.png" });
console.log(
  "PASS challenge page pinned iframe, local identity, trusted completion bridge, repeat-model score and reload persistence",
);
await browser.close();
