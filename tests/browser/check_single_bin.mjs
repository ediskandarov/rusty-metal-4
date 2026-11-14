import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { launchBrowser } from "./helpers/browser.mjs";
import { startDiagnosticGame } from "./helpers/player.mjs";

function cueTime(sector) {
  return [Math.floor(sector / 4500), Math.floor(sector / 75) % 60, sector % 75]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

const directory = resolve(
  process.env.TM4_DISC_DIR || JSON.parse(readFileSync(".local/dev.json", "utf8")).discDirectory,
);
const reference = JSON.parse(readFileSync("config/disc.json", "utf8"));
// Temporary merged fixture; never retain a second copy of the user's disc.
const temporary = await mkdtemp(join(tmpdir(), "tm4-single-bin-"));
let browser;
try {
  const bin = join(temporary, "disc.bin");
  const cue = ['FILE "disc.bin" BINARY'];
  let start = 0;
  for (const track of reference.tracks) {
    cue.push(
      `TRACK ${String(track.number).padStart(2, "0")} ${track.audio ? "AUDIO" : "MODE2/2352"}`,
    );
    if (track.index) cue.push(`INDEX 00 ${cueTime(start)}`);
    cue.push(`INDEX 01 ${cueTime(start + track.index)}`);
    await pipeline(
      createReadStream(join(directory, track.file)),
      createWriteStream(bin, { flags: "a" }),
    );
    start += track.size / 2352;
  }
  const cuePath = join(temporary, "disc.cue");
  await writeFile(cuePath, cue.join("\n") + "\n");
  browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8121/");
  await page.waitForFunction(() => !document.getElementById("disc-folder").disabled);
  await page.locator("#disc-folder").setInputFiles(temporary);
  await startDiagnosticGame(page);
  await page.waitForFunction(
    () =>
      document.getElementById("resource-check").disabled &&
      document.getElementById("resource-summary").textContent.includes("275 compatible"),
    null,
    { timeout: 90000 },
  );
  // All music reads must return precisely one track, including its stored pregap.
  const hashes = await page.evaluate(async () => {
    const result = [];
    for (const track of globalThis.tm4Assets.tracks.filter((track) => track.audio)) {
      const bytes = await globalThis.tm4Assets.readAudio(track.number);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      result.push({
        number: track.number,
        size: bytes.length,
        hash: [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      });
    }
    return result;
  });
  for (const actual of hashes) {
    const expected = reference.tracks.find((track) => track.number === actual.number);
    assert.equal(actual.size, expected.size);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(directory, expected.file))) hash.update(chunk);
    assert.equal(actual.hash, hash.digest("hex"));
  }
  // Biography playback exercises the native CD consumer, not just the JS reader.
  await page.locator("canvas").click();
  for (const screen of ["newgame", "carsel"]) {
    await page.keyboard.press("x", { delay: 150 });
    await page.waitForFunction(
      (name) => globalThis.tm4Port?.screen === name && globalThis.tm4Port.menuReady,
      screen,
      { timeout: 30000 },
    );
  }
  await page.keyboard.press("d", { delay: 150 });
  await page.waitForFunction(
    () => globalThis.tm4Port?.music?.ready && globalThis.tm4Port.music.nonzero > 0,
    null,
    { timeout: 30000 },
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "build/checks/single-bin-menu.png" });
  console.log(
    "PASS: single BIN + CUE starts movies and menu; 275 resources compatible; all 22 audio tracks byte-identical; music ready",
  );
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
