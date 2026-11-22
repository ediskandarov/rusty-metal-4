import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { checkRollbackAudio } from "./helpers/rollback-audio.mjs";

const browser = await launchBrowser({ args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
  await page.goto(new URL("?session=1", site).href);
  await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
    timeout: 60_000,
    polling: 100,
  });
  const metrics = [];
  for (const banked of [false, true, false]) metrics.push(await checkRollbackAudio(page, banked));
  assert.deepEqual(errors, []);
  console.log("PASS finite and looping rollback audio", JSON.stringify(metrics));
} finally {
  await browser.close();
}
