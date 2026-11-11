/* Client admission diagnostics against the embedded Rust server. */
const assert = require("node:assert/strict");
const { readyInLobby } = require("./network_lobby.cjs");
const { chromium } = require("playwright");
(async () => {
  const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
  const endpoint = process.env.TM4_MATCH_ENDPOINT;
  const scenario = process.env.TM4_ADMISSION_SCENARIO ?? "map";
  assert(endpoint && ["map", "roster"].includes(scenario));
  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const clients = [await browser.newPage(), await browser.newPage()];
    for (const page of clients) {
      await page.route("**/network/tm4_network.js", async (route) => {
        const response = await route.fetch();
        const hook = `\nconst admissionUpdate = NetworkClient.prototype.update;
NetworkClient.prototype.update = function() {
  const raw = admissionUpdate.call(this);
  if (!globalThis.testAdmissionPatched && JSON.parse(raw).some(({type}) => type === "prediction_prepare")) {
    globalThis.testAdmissionPatched = true;
    const engine = globalThis.Module;
    if (${JSON.stringify(scenario)} === "map") {
      const ccall = engine.ccall;
      engine.ccall = (name, ...args) => name === "WebNetWorldIndex" ? -1 : ccall(name, ...args);
    } else {
      const start = engine._WebNetRequestMatch;
      engine._WebNetRequestMatch = (...args) => {
        const result = start(...args);
        if (result && !engine._WebTestUnsupportedCarCallback()) throw new Error("Callback fixture rejected");
        return result;
      };
    }
  }
  return raw;
};\n`;
        await route.fulfill({ response, body: (await response.text()) + hook });
      });
    }
    const target = new URL(site);
    target.searchParams.set("match", endpoint);
    await Promise.all(clients.map((page) => page.goto(target.href)));
    await Promise.all(clients.map(readyInLobby));
    const statuses = [];
    for (const page of clients) {
      const status = page.locator('#status[data-match-state="error"]');
      await status.waitFor();
      statuses.push(await status.textContent());
      assert.equal(await page.evaluate(() => globalThis.tm4Port.netConfirmedTick ?? 0), 0);
    }
    const expected =
      scenario === "map" ? /session resources are missing locally/i : /roster|car callback state/i;
    assert(
      statuses.some((status) => expected.test(status)),
      JSON.stringify(statuses),
    );
    assert(
      statuses.every(
        (status) => expected.test(status) || /disconnected before|connection|socket/i.test(status),
      ),
      JSON.stringify(statuses),
    );
    console.log(
      "PASS unsupported client " + scenario + " rejected before prediction",
      JSON.stringify(statuses),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
