import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import { fixtureAction, fixtureCommands } from "../../tools/headless/fixture.mjs";
import { launchBrowser } from "./helpers/browser.mjs";
const output = resolve(process.env.TM4_TEST_RECORD ?? "build/checks/simulation-modules.json");
const site = resolve(process.env.TM4_WASM_SITE ?? "build/diagnostic/site");
const resources = resolve(process.env.TM4_RESOURCE_DIR ?? "build/resources");
const files = [...new Bun.Glob("DATA/*").scanSync({ cwd: resources })].filter((p) =>
  /\.(MR|IMG|VAB|TIM|tsv)$/i.test(p),
);
const modules = [...new Bun.Glob("modules/*.wasm").scanSync({ cwd: site })];
assert.ok(files.includes("DATA/files.tsv"), "Missing extracted disc DATA/files.tsv");
assert.ok(modules.length > 0, "Missing compiled resource modules");
const auger = await WebAssembly.compile(
  await Bun.file(join(site, "modules/c_auger.wasm")).arrayBuffer(),
);
assert.ok(
  !WebAssembly.Module.imports(auger).some(({ name }) => name.startsWith("emscripten_asm_const")),
  "Super Auger must load without a JavaScript diagnostics host",
);
const html = '<!doctype html><canvas id="canvas" width="640" height="480"></canvas>';
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    const headers = {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    };
    if (path === "/")
      return new Response(html, { headers: { ...headers, "Content-Type": "text/html" } });
    if (path.includes("..")) return new Response("Not found", { status: 404 });
    return new Response(
      Bun.file(path.startsWith("/assets/") ? join(resources, path.slice(8)) : join(site, path)),
      { headers },
    );
  },
});
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.on("console", (m) => console.log(m.text()));
  page.on("pageerror", (e) => console.log(e.stack));
  await page.goto(server.url.href);
  await page.evaluate(
    async ({ files, modules }) => {
      const load = async (path, url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Cannot load ${url}: ${response.status}`);
        return [path, new Uint8Array(await response.arrayBuffer())];
      };
      const data = await Promise.all([
        ...files.map((path) => load(path, "/assets/" + path)),
        ...modules.map((path) => load(path, "/" + path)),
      ]);
      globalThis.Module = {
        canvas: document.querySelector("canvas"),
        noInitialRun: true,
        print: console.log,
        printErr: console.error,
        onAbort: (reason) => {
          globalThis.failure = String(reason);
        },
        onRuntimeInitialized() {
          try {
            const { Module } = globalThis;
            Module.FS.mkdirTree("/DATA");
            Module.FS.mkdirTree("/modules");
            for (const [path, bytes] of data) Module.FS.writeFile("/" + path, bytes);
            Module.tm4LocalCheckpoint = true;
            Module.callMain(["--session", "--simulation-only"]);
            globalThis.ready = true;
          } catch (error) {
            globalThis.failure = String(error.stack ?? error);
          }
        },
      };
    },
    { files, modules },
  );
  await page.addScriptTag({ url: new URL("tm4_web.js", server.url).href });
  await page.waitForFunction(() => window.ready || window.failure, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.failure), undefined);
  const result = await page.evaluate(
    async ({ action, commands, opponent }) => {
      const { Module, tm4Port } = globalThis;
      const fixtureAction = eval(`(${action})`),
        fixtureCommands = eval(`(${commands})`);
      const cars = ["Orbital", opponent];
      const started = await Module.ccall(
        "WebNetStartFfa",
        "number",
        [
          "number",
          "number",
          "number",
          "number",
          "number",
          "number",
          "string",
          "string",
          "number",
          "string",
          "number",
          "number",
          "number",
        ],
        [
          8,
          3,
          0,
          12345,
          -1,
          1,
          cars.join("\n"),
          "0000000000000001\n0000000000000002",
          90,
          cars.join("\n"),
          27000,
          20,
          0,
        ],
        { async: true },
      );
      if (!started) throw new Error("start failed");
      const read = () => {
        if (!Module._WebNetCaptureState()) throw new Error("capture");
        const { tick, digest, sections, unsupported } = tm4Port.netMatch;
        if (unsupported) throw new Error(unsupported);
        return {
          tick,
          digest,
          sections,
          canonical: btoa(String.fromCharCode(...tm4Port.netCapturedState)),
        };
      };
      const rows = [read()],
        tape = [],
        events = [];
      for (let tick = 0; tick < 300; tick++) {
        const action = fixtureAction(tick);
        if (action && !Module[action[0]](action[1])) throw new Error("fixture");
        const inputs = [
          ...fixtureCommands(tick),
          ...Array.from({ length: 6 }, () => ({ buttons: 0 })),
        ];
        tape.push({ action, inputs });
        for (let slot = 0; slot < 2; slot++)
          if (!Module._WebNetSetInput(tick, slot, inputs[slot].buttons, 0, 0))
            throw new Error("input");
        if (!Module._WebNetQueueTick(tick)) throw new Error("tick");
        rows.push(read());
        if (tick === 81 && !Module._WebNetCapturePortableCheckpoint())
          throw new Error(`Portable capture at tick 82: ${tm4Port.portableCheckpointError}`);
        Module._WebTestLocalCheckpointProjectiles();
        events.push({ live: structuredClone(tm4Port.testLiveProjectiles) });
      }
      Module._WebNetCancelMatch();
      return {
        world: "Construction Yard",
        seed: 12345,
        cars,
        modelPool: cars,
        limits: { timeLimitTicks: 27000, fragLimit: 20 },
        respawnDelayTicks: 90,
        rows,
        tape,
        events,
      };
    },
    {
      action: fixtureAction.toString(),
      commands: fixtureCommands.toString(),
      opponent: process.env.TM4_TEST_OPPONENT ?? "Microblast",
    },
  );
  assert.equal(result.rows.length, 301);
  assert.ok(result.events[81].live.length > 0, "Replay checkpoint must contain a live projectile");
  await Bun.write(output, JSON.stringify(result));
  console.log("PASS dynamic resource modules: 300 browser ticks; server reference:", output);
} finally {
  await browser?.close();
  await server.stop(true);
}
