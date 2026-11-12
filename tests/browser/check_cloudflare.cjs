const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { readyInLobby } = require("./network_lobby.cjs");

// Runs against a fresh private test deployment, then stops its container.
(async () => {
  const url = process.env.TM4_CLOUDFLARE_URL;
  const code = process.env.TM4_ACCESS_CODE;
  const secret = process.env.TM4_ADMIN_SECRET;
  const disc = process.env.TM4_DISC_DIR;
  assert(
    url && code && secret && disc,
    "Set the Cloudflare URL, access code, admin secret and disc directory",
  );
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--enable-unsafe-swiftshader", "--mute-audio"],
  });
  const context = await browser.newContext();
  context.setDefaultTimeout(120000);
  let authenticated = false;
  try {
    const gate = await context.request.get(url);
    assert.equal(gate.status(), 200);
    assert((await gate.text()).includes('name="code"'));
    const rejected = await context.request.post(new URL("/_access", url).href, {
      headers: { Origin: new URL(url).origin },
      form: { code: crypto.randomUUID() },
      maxRedirects: 0,
    });
    assert.equal(rejected.status(), 401);
    const alert = /<p\b[^>]*id="access-error"[^>]*>/.exec(await rejected.text())?.[0];
    assert(alert && !alert.includes("hidden"));
    const login = await context.request.post(new URL("/_access", url).href, {
      headers: { Origin: new URL(url).origin },
      form: { code },
      maxRedirects: 0,
    });
    assert.equal(login.status(), 303);
    authenticated = true;
    const errors = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    const host = await context.newPage();
    await host.goto(url);
    await host.locator("#status").filter({ hasText: "Administrator" }).waitFor({ timeout: 120000 });
    assert(await host.evaluate(() => crossOriginIsolated));
    assert.equal(
      (await (await context.request.get(new URL("/api/status", url).href)).json()).sleeping,
      true,
      "Loading the website must not start a container",
    );
    assert.equal((await context.request.get(new URL("/api/resources", url).href)).status(), 401);
    assert.equal((await context.request.get(new URL("/DATA/MAIN.MR", url).href)).status(), 404);
    await host.locator("#secret").fill(secret);
    await host.locator("#disc").setInputFiles(disc);
    await host.locator("#prepare").click();
    await host.waitForFunction(() => !document.getElementById("start").disabled, null, {
      timeout: 180000,
    });
    console.log("Cloudflare: disc validated by native Wasmtime server");
    await host.locator("#player-count").selectOption("2");
    await host.locator("#world").selectOption("The Oil Rig");
    await host.locator("#start").click();
    await host.locator("#join").waitFor({ state: "visible", timeout: 30000 });
    const join = await host.locator("#join").getAttribute("href");
    assert.equal(
      new URL(join).searchParams.get("match"),
      new URL("/match", url).href.replace("https:", "wss:"),
    );
    const state = await context.storageState();
    const players = await Promise.all([
      browser.newPage({ storageState: state }),
      browser.newPage({ storageState: state }),
    ]);
    for (const page of players) page.on("pageerror", (error) => errors.push(error.message));
    await Promise.all(
      players.map(async (page) => {
        await page.goto(join);
        await page.waitForFunction(() => !document.getElementById("disc-folder").disabled);
        await page.locator("#disc-folder").setInputFiles(disc);
        await page.locator("#car-lobby").waitFor({ state: "visible", timeout: 120000 });
      }),
    );
    console.log("Cloudflare: two browser clients reached the Lightyear lobby over WSS");
    await Promise.all(players.map(readyInLobby));
    await Promise.all(
      players.map(async (page) => {
        await page.waitForFunction(
          () =>
            (globalThis.tm4Port?.netConfirmedTick ?? 0) >= 90 ||
            document.getElementById("status")?.dataset.matchState === "error",
          null,
          { timeout: 120000 },
        );
        assert(
          await page.evaluate(() => globalThis.tm4Port?.netConfirmedTick >= 90),
          await page.locator("#status").innerText(),
        );
      }),
    );
    for (const page of players) {
      await page.locator("canvas").focus();
      await page.keyboard.down("x");
    }
    await Promise.all(
      players.map(async (page) => {
        await page.waitForFunction(
          () =>
            (globalThis.tm4Port?.netConfirmedTick ?? 0) >= 300 ||
            document.getElementById("status")?.dataset.matchState === "error",
          null,
          { timeout: 60000 },
        );
        await page.keyboard.up("x");
        assert(
          await page.evaluate(() => globalThis.tm4Port?.netConfirmedTick >= 300),
          await page.locator("#status").innerText(),
        );
      }),
    );
    let serverState;
    for (let attempt = 0; attempt < 20; attempt++) {
      serverState = await (await context.request.get(new URL("/api/status", url).href)).json();
      if (serverState.tick >= 300) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(serverState.connected, 2);
    assert(serverState.tick >= 300, JSON.stringify(serverState));
    const headers = { Authorization: `Bearer ${secret}` };
    const measure = await context.request.post(new URL("/_server/measure", url).href, { headers });
    assert.equal(measure.status(), 200);
    const observation = await measure.text();
    assert(observation.startsWith("BEGIN\n") && observation.endsWith("END\n"));
    assert(observation.includes("memory.current") && observation.includes("cpu.stat"));
    const journal = await context.request.post(new URL("/_server/journal", url).href, { headers });
    assert.equal(journal.status(), 200);
    const bytes = await journal.body();
    assert.equal(bytes.subarray(0, 8).toString(), "TM4JRNL\x01");
    assert.equal(bytes.length, Number(journal.headers()["content-length"]));
    await Bun.write("build/cloudflare-smoke.tm4j", bytes);
    assert.deepEqual(errors, []);
    await players[0].screenshot({ path: "build/cloudflare-match.png" });
    console.log(
      "PASS Cloudflare native match",
      JSON.stringify({
        tick: serverState.tick,
        connected: serverState.connected,
        world: serverState.world,
      }),
    );
  } catch (error) {
    for (const [index, page] of browser
      .contexts()
      .flatMap((c) => c.pages())
      .entries()) {
      console.error(
        "Browser state",
        index,
        await page
          .locator("#status")
          .textContent({ timeout: 3000 })
          .catch(() => "unavailable"),
      );
      await page
        .screenshot({ path: `build/cloudflare-failure-${index}.png`, timeout: 5000 })
        .catch(() => {});
    }
    throw error;
  } finally {
    for (const c of browser.contexts()) for (const page of c.pages()) await page.close();
    if (authenticated) {
      const stopped = await context.request.post(new URL("/_server/stop", url).href, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      assert.equal(stopped.status(), 204);
    }
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
