/* global Module, tm4Port */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const { connectAuthority } = await import("../../tools/network/authority.ts");
  const endpoint = process.env.TM4_MATCH_ENDPOINT;
  const token = process.env.TM4_AUTHORITY_TOKEN;
  const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:8120/";
  if (!endpoint || !token) throw new Error("Set TM4_MATCH_ENDPOINT and TM4_AUTHORITY_TOKEN");
  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: [
      "--enable-unsafe-swiftshader",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--mute-audio",
    ],
  });
  let authorityError;
  let finished;
  try {
    const [authority, ...clients] = await Promise.all(
      Array.from({ length: 3 }, () => browser.newPage()),
    );
    const pages = [authority, ...clients];
    await Promise.all(
      pages.map(async (page, index) => {
        page.on("pageerror", (e) => console.error("PAGE", index, e));
        page.on("console", (m) => {
          if (/initialized:|Match cars|FIXTURE/.test(m.text()))
            console.log("PAGE", index, m.text());
        });
        await page.goto(
          index ? site + "?match=" + encodeURIComponent(endpoint) : site + "?authority=1",
        );
        await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
          timeout: 60000,
        });
        await page.evaluate(() => {
          const queue = Module._WebNetQueueTick;
          Module._WebNetQueueTick = (tick) => {
            if (tick === 60 && Module._WebTestPlaceWeaponTarget(128) <= 0)
              throw new Error("Could not place the cars for contact");
            if (tick === 110) {
              if (!Module._WebTestPrepareNetworkDuel(500))
                throw new Error("Could not place the target");
              console.log("FIXTURE", tick);
            }
            return queue(tick);
          };
        });
        if (index === 0) {
          await page.waitForFunction(() => tm4Port.platformReady);
          finished = connectAuthority(page, endpoint, token).catch((error) => {
            authorityError = error;
          });
        }
      }),
    );
    await Promise.all(clients.map((page) => page.waitForFunction(() => tm4Port.netCameraAttached)));
    const slots = await Promise.all(
      clients.map((page) => page.evaluate(() => tm4Port.netViewSlot)),
    );
    assert.deepEqual([...slots].sort(), [0, 1]);
    const shooter = clients[slots.indexOf(0)];
    await shooter.keyboard.down("x");
    await Promise.all(
      pages.map((page) =>
        page.waitForFunction(() => Module._WebTestNetworkCarContact(), null, { timeout: 8000 }),
      ),
    );
    await shooter.keyboard.up("x");
    await shooter.waitForFunction(() => tm4Port.netMatch.tick >= 111);
    await shooter.keyboard.down("e");
    await Promise.all(
      clients.map((page) =>
        page.waitForFunction(
          () =>
            tm4Port.netMatchServerState?.roundFinished ||
            /diverged|Disconnected/.test(document.querySelector("#status").textContent),
          null,
          { timeout: 13000 },
        ),
      ),
    );
    await shooter.keyboard.up("e");
    for (const client of clients) {
      const result = await client.evaluate(() => ({
        state: tm4Port.netMatchServerState,
        local: tm4Port.netMatch,
        confirmed: tm4Port.netConfirmedTick,
        slot: tm4Port.netViewSlot,
        status: document.querySelector("#status").textContent,
      }));
      console.log("RESULT", JSON.stringify(result));
      assert.equal(result.state.winner, 0);
      assert.deepEqual(result.state.scores, [
        { wins: 1, losses: 0 },
        { wins: 0, losses: 1 },
      ]);
      assert(result.confirmed > 0 && result.local.tick >= result.confirmed);
    }
    await shooter.waitForFunction(() => tm4Port.netMatchServerState?.acceptsContinue);
    await shooter.keyboard.down("x");
    await Promise.all(
      clients.map((page) =>
        page.waitForFunction(() =>
          document.querySelector("#status").textContent.startsWith("Match finished"),
        ),
      ),
    );
    await shooter.keyboard.up("x");
    await finished;
    assert.ifError(authorityError);
    for (const page of pages) await page.waitForFunction(() => !tm4Port.netMatch);
    // A completed session releases C state and can initialize again in this page.
    for (const page of pages) {
      assert.equal(
        await page.evaluate(() => {
          const started = Module._WebNetRequestMatch(2, 0, 54321, -1);
          const tick = tm4Port.netMatch?.tick;
          Module._WebNetCancelMatch();
          return started === 1 && tick === 0;
        }),
        true,
      );
    }
    console.log("PASS car contact, weapon input, lethal hit, result and round completion");
  } catch (error) {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      console.error(
        await page
          .evaluate(() => ({
            state: tm4Port.netMatch,
            server: tm4Port.netMatchServerState,
            cars: tm4Port.cars,
            status: document.querySelector("#status").textContent,
          }))
          .catch(() => undefined),
      );
    }
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
