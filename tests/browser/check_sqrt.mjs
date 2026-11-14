import assert from "node:assert/strict";
/* global Module */
/* Expected values come from tools/testing/sqrt-cases.js executing the original MIPS body. */
import { readFileSync } from "node:fs";

import { launchBrowser } from "./helpers/browser.mjs";
import { startDiagnosticGame } from "./helpers/player.mjs";
const cases = JSON.parse(readFileSync("build/checks/sqrt-cases.json", "utf8"));

const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
  await startDiagnosticGame(page);
  for (const [name, entries] of Object.entries(cases)) {
    const failures = await page.evaluate(
      ({ name, entries }) =>
        entries.flatMap((entry) => {
          const args = entry.slice(0, -1);
          const expected = entry[entry.length - 1];
          const actual = Module["_WebTest" + name](...args) >>> 0;
          return actual === expected ? [] : [{ args, expected, actual }];
        }),
      { name, entries },
    );
    assert.deepEqual(failures.slice(0, 20), [], `${name}: ${failures.length} mismatches`);
    console.log(`PASS ${name}: ${entries.length} cases against original MIPS`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
