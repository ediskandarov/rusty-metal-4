const assert = require("node:assert/strict");
const { mkdtempSync, readdirSync, rmdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

// Build the server bundle/native binary first. A disc is optional for the setup smoke;
// TM4_DISC_DIR also exercises administrator provisioning and two local players.
(async () => {
  const mode = process.env.TM4_SERVER_MODE ?? "dev";
  const directory = resolve(`build/${mode}/server`);
  const httpPort = Number(process.env.TM4_SERVER_TEST_PORT ?? 18290);
  const matchPort = httpPort + 1;
  const url = `http://127.0.0.1:${httpPort}/`;
  const secret = crypto.randomUUID();
  const temporary = mkdtempSync(resolve("build/server-smoke-private-"));
  const profile = mode === "release" ? "release" : "debug";
  const executable = resolve(
    `build/network-native/${profile}/tm4-deathmatch-server${process.platform === "win32" ? ".exe" : ""}`,
  );
  let logs = "";
  const server = Bun.spawn([executable, "--serve", "4"], {
    env: {
      ...process.env,
      TM4_ADMIN_SECRET: secret,
      TM4_HTTP_LISTEN: `127.0.0.1:${httpPort}`,
      TM4_MATCH_LISTEN: `127.0.0.1:${matchPort}`,
      TM4_SERVER_SITE_DIR: resolve(directory, "site"),
      TM4_SIMULATION_WASM: resolve(directory, "tm4_standalone.wasm"),
      TM4_JOURNAL_DIR: resolve("build/server-smoke-journal"),
      TMPDIR: temporary,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const capture = async (stream) => {
    for await (const bytes of stream) logs += new TextDecoder().decode(bytes);
  };
  const output = Promise.all([capture(server.stdout), capture(server.stderr)]);
  let browser;
  const request = (path, init = {}) => fetch(new URL(path, url), init);
  const admin = (method, body) => ({
    method,
    headers: { Authorization: `Bearer ${secret}` },
    body,
  });
  try {
    for (let retry = 0; ; retry++) {
      try {
        if ((await request("/api/status")).ok) break;
      } catch {
        /* Starting. */
      }
      if (retry >= 100 || server.exitCode !== null)
        throw new Error(`Server did not start: ${logs}`);
      await Bun.sleep(50);
    }
    const response = await request("/");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
    assert.equal(response.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
    const head = await request("/play/tm4_web.wasm", { method: "HEAD" });
    assert.equal(head.headers.get("Content-Type"), "application/wasm");
    assert.equal(
      Number(head.headers.get("Content-Length")),
      Bun.file(resolve(directory, "site/play/tm4_web.wasm")).size,
    );
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await (await request("/api/status")).json()).phase, "setup");
    assert.equal((await request("/api/start", { method: "POST" })).status, 401);
    assert.equal((await request("/api/start", admin("POST"))).status, 409);
    assert.equal((await request("/api/prepare", admin("POST"))).status, 400);
    assert.equal(
      (await request("/api/resources/DATA/MAIN.MR", admin("PUT", new Uint8Array([0])))).status,
      400,
    );
    const state = await (await request("/api/status")).json();
    assert.equal(state.phase, "setup");
    assert.equal(state.uploaded, 0);
    for (const path of ["/DATA/MAIN.MR", "/api/resources/DATA/MAIN.MR", "/%2e%2e%2fCargo.toml"])
      assert.notEqual((await request(path)).status, 200);

    browser = await chromium.launch({
      executablePath:
        process.env.TM4_CHROME ||
        (process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : undefined),
      headless: true,
      args: ["--enable-unsafe-swiftshader", "--mute-audio"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator("#status").filter({ hasText: "Administrator" }).waitFor();
    assert(await page.locator("#setup").evaluate((node) => node.open));
    assert(await page.locator("#join").isHidden());
    assert(await page.evaluate(() => crossOriginIsolated));
    assert.equal(await page.locator("#player-count").inputValue(), "4");
    await page.locator("#player-count").selectOption("2");
    await page.waitForTimeout(1700);
    assert.equal(
      await page.locator("#player-count").inputValue(),
      "2",
      "Polling must preserve an unsent selection",
    );
    if (process.env.TM4_DISC_DIR) {
      await page.locator("#secret").fill(secret);
      await page.locator("#disc").setInputFiles(process.env.TM4_DISC_DIR);
      await page.locator("#prepare").click();
      await page.waitForFunction(
        () =>
          !document.getElementById("start").disabled ||
          !document.getElementById("prepare").disabled,
        null,
        { timeout: 120000 },
      );
      assert(await page.locator("#start").isEnabled(), await page.locator("#progress").innerText());
      const prepared = await (await request("/api/status")).json();
      assert.equal(prepared.phase, "ready");
      assert(prepared.worlds.includes("The Oil Rig"));
      await page.locator("#world").selectOption("The Oil Rig");
      await page.waitForTimeout(1700);
      assert.equal(await page.locator("#world").inputValue(), "The Oil Rig");
      await page.locator("#start").click();
      await page.locator("#join").waitFor({ state: "visible", timeout: 15000 });
      assert.equal((await (await request("/api/status")).json()).world, "The Oil Rig");
      assert(await page.locator("#world").isDisabled());
      assert.equal((await (await request("/api/status")).json()).phase, "lobby");
      assert.equal(
        (await request("/api/resources/DATA/MAIN.MR", admin("PUT", new Uint8Array([0])))).status,
        409,
      );
      assert.equal((await request("/DATA/MAIN.MR")).status, 404);
      assert.equal((await (await request("/api/status")).json()).players, 2);
      assert(await page.locator("#player-count").isDisabled());
      const join = await page.locator("#join").getAttribute("href");
      const clients = await Promise.all([browser.newPage(), browser.newPage()]);
      const uploads = [];
      for (const client of clients) {
        client.on("pageerror", (error) => errors.push(error.message));
        client.on("requestfailed", (request) =>
          console.error("player request:", request.url(), request.failure()),
        );
        client.on("request", (request) => {
          if (request.method() === "PUT" || request.method() === "POST")
            uploads.push(request.url());
        });
      }
      await Promise.all(
        clients.map(async (client) => {
          const navigation = await client.goto(join);
          assert.equal(
            navigation.status(),
            200,
            `Player navigation: ${join} ${await navigation.text()}`,
          );
          await client.waitForFunction(
            () => !document.getElementById("disc-folder").disabled,
            null,
            { timeout: 10000 },
          );
          await client.locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
          await client.locator("#car-lobby").waitFor({ state: "visible", timeout: 120000 });
        }),
      );
      assert.equal((await (await request("/api/status")).json()).phase, "lobby");
      for (const client of clients)
        assert.equal(await client.evaluate(() => globalThis.tm4Port?.netConfirmedTick ?? 0), 0);
      // A pre-match reload releases the old selection/readiness rather than starting a match.
      await clients[0].locator("#car-ready").click();
      await clients[0].locator("#car-ready").filter({ hasText: "Not ready" }).waitFor();
      await clients[0].reload();
      await clients[0].waitForFunction(() => !document.getElementById("disc-folder").disabled);
      await clients[0].locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
      await clients[0].locator("#car-lobby").waitFor({ state: "visible", timeout: 60000 });
      assert.equal(await clients[0].locator("#car-ready").innerText(), "Ready");
      assert.equal((await (await request("/api/status")).json()).phase, "lobby");
      const chosenCars = ["Calypso", "Quatro"];
      for (const [index, client] of clients.entries()) {
        await client.locator("#car-choice").selectOption(chosenCars[index]);
        await client.waitForFunction(() => !document.getElementById("car-ready").disabled);
      }
      await clients[0].locator("#car-ready").click();
      await clients[0].locator("#car-ready").filter({ hasText: "Not ready" }).waitFor();
      assert.equal((await (await request("/api/status")).json()).phase, "lobby");
      await clients[0].locator("#car-ready").click();
      await clients[0]
        .locator("#car-ready")
        .filter({ hasText: /^Ready$/ })
        .waitFor();
      await clients[0].screenshot({ path: "build/server-car-lobby.png" });
      await Promise.all(clients.map((client) => client.locator("#car-ready").click()));
      await Promise.all(
        clients.map(async (client) => {
          await client.waitForFunction(
            () =>
              globalThis.tm4Port?.netConfirmedTick > 30 ||
              document.getElementById("status")?.dataset.matchState === "error" ||
              document.getElementById("startup-progress")?.textContent.includes("Reload the page"),
            null,
            {
              timeout: 120000,
            },
          );
          assert(
            await client.evaluate(() => globalThis.tm4Port?.netConfirmedTick > 30),
            (await client.locator("#status").innerText()) +
              " " +
              (await client.locator("#startup-progress").innerText()),
          );
        }),
      );
      for (const client of clients) assert(await client.locator("#car-lobby").isHidden());
      const roster = [];
      for (const [index, client] of clients.entries())
        roster[await client.evaluate(() => globalThis.tm4Port.netViewSlot)] = chosenCars[index];
      const journalPath = /Match journal: (.+)/.exec(logs)?.[1];
      assert(journalPath, "The server must journal the chosen roster");
      const journal = Bun.spawnSync([executable, "--inspect-journal", journalPath]);
      assert.equal(journal.exitCode, 0);
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(journal.stdout)).header.start.cars,
        roster,
      );
      // A running match restores the player's existing car without another lobby confirmation.
      await clients[0].reload();
      await clients[0].waitForFunction(() => !document.getElementById("disc-folder").disabled);
      await clients[0].locator("#disc-folder").setInputFiles(process.env.TM4_DISC_DIR);
      await clients[0].waitForFunction(
        () =>
          globalThis.tm4Port?.netConfirmedTick > 30 ||
          document.getElementById("status")?.dataset.matchState === "error",
        null,
        { timeout: 60000 },
      );
      assert(
        await clients[0].evaluate(() => globalThis.tm4Port?.netConfirmedTick > 30),
        await clients[0].locator("#status").innerText(),
      );
      assert(await clients[0].locator("#car-lobby").isHidden());
      assert.deepEqual(uploads, [], "Players must not upload their disc resources");
      assert.equal((await (await request("/api/status")).json()).phase, "match");
      console.log(
        "PASS: browser administrator provisioning and two players reached native match ticks",
      );
    } else {
      const player = await browser.newPage();
      await player.goto(new URL("play/", url).href);
      await player.waitForFunction(() => !document.getElementById("disc-folder").disabled);
      assert(await player.locator("#startup").isVisible());
    }
    assert.deepEqual(errors, []);
    assert(!logs.includes(secret));
    console.log(
      "PASS: native setup before resources, isolated static/wasm serving, authentication, invalid upload safety, and browser setup",
    );
  } catch (error) {
    console.error(logs);
    for (const context of browser?.contexts() ?? []) {
      for (const page of context.pages()) {
        console.error(
          await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            progress: document.getElementById("startup-progress")?.textContent,
            status: document.getElementById("status")?.textContent,
          })),
        );
      }
    }
    throw error;
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    await server.exited;
    await output;
    assert.deepEqual(
      readdirSync(temporary),
      [],
      "Private uploaded resources must be removed on shutdown",
    );
    rmdirSync(temporary);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
