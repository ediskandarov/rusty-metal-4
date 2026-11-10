/* global tm4Port */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const { connectAuthority } = await import("../../tools/network/authority.ts");
  const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
  const endpoint = process.env.TM4_MATCH_ENDPOINT;
  const token = process.env.TM4_AUTHORITY_TOKEN;
  const scenario = process.env.TM4_ADMISSION_SCENARIO ?? "map";
  assert(endpoint && token && ["map", "roster"].includes(scenario));

  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const authority = await browser.newPage();
    await authority.goto(new URL("?authority=1", site).href);
    await authority.waitForFunction(() => globalThis.tm4Port?.compatibility);
    await authority.evaluate((scenario) => {
      if (scenario === "map") tm4Port.catalog.worlds = ["Oil Rig"];
      else {
        if (!tm4Port.catalog.cars.includes("Microblast"))
          throw new Error("Missing Microblast fixture");
        tm4Port.catalog.cars = ["Orbital", "Microblast"];
      }
    }, scenario);
    let authorityError;
    void connectAuthority(authority, endpoint, token).catch((error) => (authorityError = error));
    const url = new URL(site);
    url.searchParams.set("match", endpoint);
    const clients = [await browser.newPage(), await browser.newPage()];
    await Promise.all(clients.map((page) => page.goto(url.href)));
    const message =
      scenario === "map" ? /requires stock Construction Yard/ : /roster|car callback state/i;
    for (const page of clients) {
      const status = page.locator('#status[data-match-state="error"]');
      await status.waitFor();
      assert.match(await status.textContent(), message);
      assert.equal(await page.evaluate(() => tm4Port.netConfirmedTick ?? 0), 0);
    }
    assert.equal(await authority.evaluate(() => tm4Port.netMatch?.tick ?? 0), 0);
    if (authorityError) assert.match(authorityError.message, message);
    console.log("PASS unsupported network " + scenario + " rejected before prediction");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
