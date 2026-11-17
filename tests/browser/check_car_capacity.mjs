/* global Module */
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { serveHost } from "../../tools/network/serve.ts";
import { launchBrowser } from "./helpers/browser.mjs";

assert(process.env.TM4_DISC_DIR, "Set TM4_DISC_DIR to your local disc folder");
const atlasCount = process.env.TM4_EXTENDED_VRAM === "1" ? 10 : 8;
const site = resolve(process.env.TM4_WASM_SITE || "build/diagnostic/site");
const host = await serveHost({ site, api: "http://127.0.0.1:1", port: 0 });
const browser = await launchBrowser({ args: ["--mute-audio"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(new URL("?session=1&checkpoint=1", host.url).href);
  await page.waitForFunction(() => !document.getElementById("disc-folder").disabled);
  await page.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
  await page.waitForFunction(
    () => globalThis.tm4Port?.compatibility && globalThis.tm4Port?.platformReady,
    null,
    {
      timeout: 60000,
    },
  );
  const result = await page.evaluate(async () => {
    const capacity = Module._WebTestCarAtlasCapacity();
    const cars = "Orbital\nPizza Boy\nMicroblast\nCalypso";
    const ids = "0000000000000001\n0000000000000002\n0000000000000003\n0000000000000004";
    const start = (slots) =>
      Module.ccall(
        "WebNetStartTournament",
        "number",
        ["number", "number", "number", "number", "number", "number", "string", "string"],
        [
          8,
          slots,
          0,
          12345,
          0,
          1,
          slots === 3 ? cars.split("\n").slice(0, 2).join("\n") : cars,
          slots === 3 ? ids.split("\n").slice(0, 2).join("\n") : ids,
        ],
        { async: true },
      );
    let rejected = null;
    if (capacity === 8) rejected = !(await start(15));
    const started = await start(3);
    const radar = started
      ? [Module._WebTestRadarCapacity(9), Module._WebTestRadarCapacity(10)]
      : [];
    Module._WebNetCancelMatch();
    return { capacity, rejected, started, radar };
  });
  assert.deepEqual(errors, []);
  assert.equal(result.capacity, atlasCount);
  if (atlasCount === 8) assert.equal(result.rejected, true);
  assert.equal(result.started, 1);
  assert.deepEqual(result.radar, [0, 0]);
  console.log(
    `PASS ${atlasCount} model atlases: 9/10 live-car radar packets, guards, links and rendered pixels`,
  );
} finally {
  await browser.close();
  await host.stop(true);
}
