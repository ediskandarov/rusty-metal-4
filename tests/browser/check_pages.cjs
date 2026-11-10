/* global Module, tm4Network */
const assert = require("node:assert/strict");
const { lstatSync, readdirSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const site = resolve("build/release/site");
  const allowed = new Set([
    "index.html",
    "web.js",
    "tm4_web.js",
    "tm4_web.wasm",
    "coi-serviceworker.js",
    "coi-serviceworker.LICENSE.txt",
    "simulation-build.json",
    "network/tm4_network.js",
    "network/tm4_network_bg.wasm",
    "network/tm4_network.d.ts",
    "network/tm4_network_bg.wasm.d.ts",
  ]);
  for (const path of readdirSync(site, { recursive: true })) {
    const stat = lstatSync(join(site, path));
    if (stat.isDirectory()) continue;
    assert(stat.isFile(), `Only regular files can be published: ${path}`);
    assert(
      allowed.has(path) || /^styles\/[\w-]+\.css$/.test(path),
      `Unexpected file in the public site: ${path}`,
    );
  }

  let server, browser, probe;
  try {
    let url = process.env.TM4_PAGES_URL;
    if (!url) {
      const { staticFile } = await import("../../tools/server/files.js");
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (!path.startsWith("/tm4_rewired/")) return new Response(null, { status: 404 });
          const name = decodeURIComponent(path.slice("/tm4_rewired".length));
          const file = await staticFile(site, name.endsWith("/") ? name + "index.html" : name);
          // Deliberately omit COOP/COEP, like GitHub Pages.
          return file && (await file.exists())
            ? new Response(file, { headers: { "Cache-Control": "no-store" } })
            : new Response(null, { status: 404 });
        },
      });
      url = new URL("tm4_rewired/", server.url).href;
      assert.equal((await fetch(url)).headers.get("Cross-Origin-Opener-Policy"), null);
    }
    browser = await chromium.launch({
      executablePath:
        process.env.TM4_CHROME ||
        (process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : undefined),
      headless: true,
      args: ["--enable-unsafe-swiftshader"],
    });
    const page = await browser.newPage();
    page.on("console", (message) => console.log("browser:", message.text()));
    const errors = [],
      requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(url);
    await page.waitForFunction(
      () => crossOriginIsolated && !document.getElementById("disc-folder").disabled,
      null,
      { timeout: 30000 },
    );
    assert(await page.locator("#disc-folder").isEnabled());
    assert(await page.locator("#startup").isVisible());
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    assert.equal(scope, new URL(".", url).href);
    assert(!requests.some((path) => path.endsWith(".wasm")), "Runtime waits for disc selection");

    // Initialize the real shared-memory runtime without starting the game or supplying a disc.
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          globalThis.Module = {
            canvas: document.querySelector("canvas"),
            noInitialRun: true,
            onAbort: (reason) => reject(new Error(String(reason))),
            onRuntimeInitialized: () => resolve(),
          };
          const script = document.createElement("script");
          script.src = "tm4_web.js";
          script.onerror = () => reject(new Error("Runtime script failed to load"));
          document.body.append(script);
        }),
    );
    assert(
      await page.evaluate(
        () => typeof Module._main === "function" && typeof SharedArrayBuffer === "function",
      ),
    );
    assert.deepEqual(
      await page.evaluate(() => Object.keys(Module).filter((name) => name.startsWith("_WebTest"))),
      [],
    );
    await page.waitForFunction(() =>
      performance.getEntriesByType("resource").some((entry) => entry.name.endsWith("tm4_web.wasm")),
    );
    const fingerprint = await (await fetch(new URL("simulation-build.json", url))).json();
    assert.deepEqual(Object.keys(fingerprint), ["sha256"]);
    assert.match(fingerprint.sha256, /^[0-9a-f]{64}$/);
    // Loading through the real bridge must resolve both generated modules beneath
    // the application path. No game files are needed to initialize networking.
    let probeOpened = false;
    probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 404 });
      },
      websocket: {
        open() {
          probeOpened = true;
        },
        message() {},
      },
    });
    const endpoint = new URL(probe.url);
    endpoint.protocol = "ws:";
    await page.evaluate(async (endpoint) => {
      const connection = await tm4Network.connect(endpoint);
      globalThis.pagesNetworkProbe = connection;
      await new Promise((resolve, reject) => {
        connection.onopen = resolve;
        connection.onerror = reject;
      });
    }, endpoint.href);
    const deadline = Date.now() + 5000;
    while (!probeOpened && Date.now() < deadline) await Bun.sleep(10);
    assert(probeOpened, "Networking probe did not open its WebSocket");
    await page.evaluate(() => globalThis.pagesNetworkProbe.close());
    const base = new URL(".", url).pathname;
    for (const file of ["tm4_network.js", "tm4_network_bg.wasm"]) {
      assert(
        requests.includes(base + "network/" + file),
        `Networking loaded outside application subpath: ${file}`,
      );
      assert(
        !requests.includes("/network/" + file),
        `Networking escaped application subpath: ${file}`,
      );
    }
    for (const path of ["__dev/disc.json", "__dev/files/0"])
      assert.equal((await fetch(new URL(path, url))).status, 404);
    assert(
      !requests.some((path) =>
        /\/__dev\/|\/SCUS_945\.60$|\.(bin|cue|ccd|img|mr|str|vab|tim|sub|data|exe)$/i.test(path),
      ),
      "Public site must not request disc resources",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS Pages subpath, first-visit isolation, C and Rust/Wasm runtimes and asset-free release",
    );
  } finally {
    await browser?.close();
    server?.stop(true);
    probe?.stop(true);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
