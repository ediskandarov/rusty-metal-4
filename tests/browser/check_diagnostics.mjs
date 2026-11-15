import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { launchBrowser } from "./helpers/browser.mjs";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/checks/diagnostics");
await mkdir(output, { recursive: true });
const library = Bun.resolveSync("fflate", resolve(root, "apps/player"));
const { unzipSync, strFromU8 } = await import(library);
const entry = resolve(output, "entry.ts");
await Bun.write(
  entry,
  `
import { startClientJournal } from ${JSON.stringify(resolve(root, "packages/game-runtime/src/network/journal.ts"))};
import { initializeTroubleshoot } from ${JSON.stringify(resolve(root, "apps/player/src/ui/troubleshoot.ts"))};
const journal = startClientJournal();
journal.identify({ roomId: "a".repeat(32), matchId: "11111111-1111-4111-8111-111111111111", world: "Road Rage", compatibility: {build: "test"} });
journal.record("step", 42, { digest: 123 });
globalThis.Module = { _WebCaptureFrame() {
  if (globalThis.failFrame) return 0;
  Module.onCapturedFrame(2, 2, new Uint8Array([255,0,0, 0,255,0, 0,0,255, 255,255,255]));
  return 1;
}};
initializeTroubleshoot();
globalThis.replaceJournal = () => { const next = startClientJournal(); next.identify({ matchId: "new" }); };
`,
);
const build = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  outdir: output,
  define: { "import.meta.env.PUBLIC_BUILD_COMMIT": JSON.stringify("a".repeat(40)) },
});
assert(build.success, "diagnostics browser bundle");
let requests = 0;
let failServer = false;
let release;
let requestStarted;
const started = new Promise((resolve) => {
  requestStarted = resolve;
});
const fixture = new Uint8Array([84, 77, 52, 74, 82, 78, 76, 4]);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/entry.js") return new Response(Bun.file(resolve(output, "entry.js")));
    if (path.startsWith("/api/")) {
      requests++;
      assert.equal(
        path,
        "/api/rooms/" + "a".repeat(32) + "/match/11111111-1111-4111-8111-111111111111/journal",
      );
      if (failServer) return new Response("expired", { status: 404 });
      await new Promise((resolve) => {
        release = resolve;
        requestStarted();
      });
      return new Response(fixture, { headers: { "X-Journal-Saved-At": "1234" } });
    }
    return new Response(
      `<button id="download-diagnostics">Download</button><p id="journal-status"></p><script type="module" src="/entry.js"></script>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  const button = page.locator("#download-diagnostics");
  const firstDownload = page.waitForEvent("download");
  await button.click();
  assert(await button.isDisabled());
  await page.evaluate(() => globalThis.replaceJournal());
  await started;
  assert.equal(requests, 1);
  release();
  const downloaded = await firstDownload;
  const archive = unzipSync(new Uint8Array(await Bun.file(await downloaded.path()).arrayBuffer()));
  assert.deepEqual(Object.keys(archive).sort(), [
    "client.json",
    "frame.png",
    "report.json",
    "server.tm4j",
  ]);
  assert.deepEqual(archive["server.tm4j"], fixture);
  const report = JSON.parse(strFromU8(archive["report.json"]));
  assert.equal(report.match.world, "Road Rage");
  assert.equal(report.artifacts.server.savedAt, 1234);
  assert.equal(report.artifacts.client.head, 42);
  assert.equal(report.build.commit, "a".repeat(40));
  assert.equal(JSON.parse(strFromU8(archive["client.json"])).head, 42);
  const image = await page.evaluate(
    async (png) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(png)], { type: "image/png" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return [...ctx.getImageData(0, 0, 2, 2).data];
    },
    [...archive["frame.png"]],
  );
  assert.deepEqual(image, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  failServer = true;
  await page.reload();
  await page.evaluate(() => {
    globalThis.failFrame = true;
  });
  const partialDownload = page.waitForEvent("download");
  await button.click();
  const partial = unzipSync(
    new Uint8Array(await Bun.file(await (await partialDownload).path()).arrayBuffer()),
  );
  assert.deepEqual(Object.keys(partial).sort(), ["client.json", "report.json"]);
  const partialReport = JSON.parse(strFromU8(partial["report.json"]));
  assert.match(partialReport.artifacts.server.error, /404/);
  assert.match(partialReport.artifacts.frame.error, /No game frame/);
  assert.match(await page.locator("#journal-status").textContent(), /without: frame, server/);
  assert(await button.isEnabled());
  assert.deepEqual(errors, []);
  console.log(
    "PASS diagnostic ZIP: both journals, exact PNG pixels, frozen identity, duplicate click guard, partial failure",
  );
} finally {
  await browser.close();
  server.stop(true);
}
