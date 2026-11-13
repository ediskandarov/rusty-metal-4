const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { readyInLobby } = require("./network_lobby.cjs");

const target = new URL(process.env.TM4_WEB_URL ?? "http://127.0.0.1:8348/");
assert(process.env.TM4_MATCH_ENDPOINT, "Set TM4_MATCH_ENDPOINT to a fresh two-player server");
target.searchParams.set("match", process.env.TM4_MATCH_ENDPOINT);

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const errors = [];
    const clients = await Promise.all(
      [0, 1].map(async () => {
        const page = await browser.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/network/tm4_network.js", async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            body:
              (await response.text()) +
              `
            const updateNetwork = NetworkClient.prototype.update;
            NetworkClient.prototype.update = function() {
              if (performance.now() < (globalThis.testNetworkPauseUntil || 0)) return "[]";
              const result = updateNetwork.call(this);
              for (const message of JSON.parse(result)) {
                if (message.type === "prediction_recovery_required")
                  (globalThis.testNetworkRecoveries ||= []).push(message);
              }
              return result;
            };
          `,
          });
        });
        await page.goto(target.href);
        await readyInLobby(page);
        return page;
      }),
    );
    const tick = (page) => page.evaluate(() => globalThis.tm4Port?.netConfirmedTick ?? 0);
    const wait = async (page, condition) => {
      await page.waitForFunction(condition, null, { timeout: 60000 });
      assert.notEqual(
        await page.locator("#status").getAttribute("data-match-state"),
        "error",
        await page.locator("#status").textContent(),
      );
    };
    const playing = () =>
      (globalThis.tm4Port?.netConfirmedTick ?? 0) >= 30 ||
      document.getElementById("status").dataset.matchState === "error";
    await Promise.all(clients.map((page) => wait(page, playing)));
    const [client, peer] = clients;
    const peerBefore = await tick(peer);
    // Headless Chrome does not hide tabs; emit the browser lifecycle deterministically.
    await client.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert(
      (await tick(peer)) > peerBefore + 30,
      "Peer must keep simulating while the tab is hidden",
    );
    await client.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const recovered = () => {
      const port = globalThis.tm4Port;
      return (
        (port?.netDiagnostics?.recoveredTick > 0 &&
          port.netConfirmedTick > port.netDiagnostics.recoveredTick + 30) ||
        document.getElementById("status").dataset.matchState === "error"
      );
    };
    await wait(client, recovered);
    const firstRecovery = await client.evaluate(() => tm4Port.netDiagnostics.recoveredTick);
    // Simulate a frozen event loop without a visibility event (e.g. Safari suspension).
    await client.evaluate(() => {
      globalThis.previousRecovery = tm4Port.netDiagnostics.recoveredTick;
      const deadline = performance.now() + 1500;
      while (performance.now() < deadline) {}
    });
    await wait(client, () => {
      const port = globalThis.tm4Port;
      return (
        (port?.netDiagnostics?.recoveredTick > globalThis.previousRecovery &&
          port.netConfirmedTick > port.netDiagnostics.recoveredTick + 30) ||
        document.getElementById("status").dataset.matchState === "error"
      );
    });
    assert((await tick(client)) > firstRecovery + 30);
    // Keep JS/render/input running but delay the native network pump, so its stale
    // clock and message batch must request recovery rather than throw a fatal error.
    await client.evaluate(() => {
      globalThis.previousRecovery = tm4Port.netDiagnostics.recoveredTick;
      globalThis.testNetworkPauseUntil = performance.now() + 1700;
    });
    await wait(client, () => {
      const port = globalThis.tm4Port;
      return (
        (port?.netDiagnostics?.recoveredTick > globalThis.previousRecovery &&
          port.netConfirmedTick > port.netDiagnostics.recoveredTick + 30) ||
        document.getElementById("status").dataset.matchState === "error"
      );
    });
    const recoveries = await client.evaluate(() => globalThis.testNetworkRecoveries ?? []);
    assert(
      recoveries.length > 0,
      "Rust must explicitly request recovery after its timeline expires",
    );
    assert.deepEqual(errors, []);
    console.log("PASS hidden-tab, frozen-event-loop and native network-pause recovery", recoveries);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
