/* global tm4Port */
const assert = require("node:assert/strict");
const { readyInLobby } = require("./network_lobby.cjs");
const { launchBrowser } = require("./helpers/browser.cjs");
const { execFileSync } = require("node:child_process");
const { instrument, sample, waitTick, schedule, drive } = require("./network_session.cjs");
const { fixtureTape, observeAcceptedFrames } = require("./simulation_reference.cjs");

(async () => {
  const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:19420/";
  const endpoint = process.env.TM4_MATCH_ENDPOINT;
  const count = Number(process.env.TM4_MATCH_PLAYERS ?? 2);
  const latency = Number(process.env.TM4_LIVE_DELAY_MS ?? 72);
  const jitter = Number(process.env.TM4_LIVE_JITTER_MS ?? 12);
  const mixed = process.env.TM4_MIXED_COMBAT === "1";
  const carnival = process.env.TM4_MATCH_WORLD === "The Carnival";
  const combat = process.env.TM4_ROSTER_COMBAT === "1";
  const sustain = Number(process.env.TM4_ROSTER_TICKS ?? 300);
  const width = Number(process.env.TM4_ROSTER_WIDTH ?? 960);
  const height = Number(process.env.TM4_ROSTER_HEIGHT ?? 720);
  assert(endpoint && Number.isInteger(count) && count >= 2 && count <= 8);
  const browser = await launchBrowser();
  try {
    const errors = [];
    const reference = await browser.newPage();
    reference.on("pageerror", (error) => errors.push(error.message));
    await reference.addInitScript(() => {
      window.requestAnimationFrame = () => 0;
    });
    await reference.goto(new URL("?simulation-reference=1", site).href);
    await reference.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
      timeout: 60000,
      polling: 50,
    });
    await instrument(reference);
    const writeAction = await fixtureTape({
      cars: process.env.TM4_MATCH_CARS?.split(","),
      world: process.env.TM4_MATCH_WORLD,
    });
    const pages = [];
    const url = new URL(site);
    url.searchParams.set("match", endpoint);
    for (let i = 0; i < count; i++) {
      const page = await browser.newPage({ viewport: { width, height } });
      page.on("pageerror", (e) => errors.push(e.message));
      pages.push(page);
    }
    const observation = await observeAcceptedFrames(reference, pages);
    for (const page of pages) {
      await page.goto(url.href);
      await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 60000 });
      await instrument(page, { client: true, latency, jitter });
    }
    await Promise.all(pages.map(readyInLobby));
    await Promise.all(pages.map((p) => waitTick(p, 35, 60000)));
    const first = await Promise.all(pages.map(sample));
    assert.deepEqual(
      first.map((x) => x.slot).sort((a, b) => a - b),
      Array.from({ length: count }, (_, i) => i),
    );
    for (const page of pages) await drive(page);
    for (const index of [0, count - 1])
      await pages[index].screenshot({
        path: `build/r325-roster-${count}-${latency}-${jitter}-slot-${first[index].slot}.png`,
      });
    const processSession = await browser.newBrowserCDPSession();
    const processInfo = await processSession.send("SystemInfo.getProcessInfo");
    const processIds = processInfo.processInfo.map((info) => info.id);
    const rss = () =>
      execFileSync("ps", ["-o", "pid=,rss=", "-p", processIds.join(",")], { encoding: "utf8" })
        .trim()
        .split("\n")
        .reduce((total, line) => total + Number(line.trim().split(/\s+/)[1] ?? 0), 0) * 1024;
    const initialRss = rss();
    const start = await sample(pages[0]);
    if (mixed) {
      assert.equal(count, 2);
      const drill = pages[first.findIndex((x) => x.slot === 1)];
      const minion = pages[first.findIndex((x) => x.slot === 0)];
      await drill.keyboard.down("w");
      const pair = await schedule(reference, pages, writeAction, "pair", [1, 0, 0, 1]);
      await waitTick(drill, pair + 2);
      await reference.waitForFunction(() => globalThis.tm4SessionTest.held, null, {
        timeout: 8000,
        polling: 50,
      });
      await drill.keyboard.up("w");
      const head = await sample(reference);
      const range = {
        start: head.tick + 24,
        end: head.tick + 100,
        source: 0,
        target: 1,
        name: "Freeze",
      };
      await writeAction(range.start, "projectile", undefined, {
        args: [range.source, range.target],
        until: range.end,
        projectile: range.name,
      });
      await Promise.all(
        [reference, ...pages].map((p) =>
          p.evaluate((range) => globalThis.tm4SessionTest.ranges.push(range), range),
        ),
      );
      await waitTick(minion, range.start);
      await minion.keyboard.down("w");
      await reference.waitForFunction(() => globalThis.tm4SessionTest.interrupted, null, {
        timeout: 8000,
        polling: 50,
      });
      await minion.keyboard.up("w");
      await schedule(reference, pages, writeAction, carnival ? "coaster" : "helicopter");
      await reference.waitForFunction(
        (carnival) => (carnival ? tm4Port.coasterPlayerHits > 0 : tm4Port.helicopterRemoved > 0),
        carnival,
        {
          timeout: 12000,
          polling: 50,
        },
      );
    }
    if (combat) {
      const target = await schedule(reference, pages, writeAction, "pair", [0, 1, 600, 0]);
      await waitTick(pages[0], target + 1);
      for (const page of pages) {
        await page.keyboard.down("e");
        await page.keyboard.down("w");
      }
    }
    const finalTick = Math.max(start.tick + sustain, (await sample(reference)).tick + 20);
    await Promise.all(pages.map((p) => waitTick(p, finalTick, Math.max(30000, sustain * 45))));
    const beforeDeath = await sample(pages[0]);
    if (combat)
      for (const page of pages) {
        await page.keyboard.up("e");
        await page.keyboard.up("w");
      }
    if (mixed) {
      const death = await schedule(reference, pages, writeAction, "death", [0, 1, 500]);
      await waitTick(pages[0], death + 2);
      await pages[0].keyboard.down("e");
      await reference
        .waitForFunction(() => globalThis.tm4SessionTest.deaths, null, {
          timeout: 10000,
          polling: 50,
        })
        .catch(async (error) => {
          console.error("DEATH STATE", JSON.stringify(await sample(reference)));
          throw error;
        });
      await pages[0].keyboard.up("e");
    }
    const end = (await sample(reference)).tick + 10;
    const states = await Promise.all(pages.map((p) => waitTick(p, end)));
    for (const [index, s] of states.entries()) {
      s.renderHz = ((s.frames - first[index].frames) * 1000) / (s.now - first[index].now);
      assert(s.verified > 100 && s.lastVerified === s.confirmed, JSON.stringify(s));
      assert.equal(s.audioDuringReplay, 0);
      assert.equal(s.publications, s.steps - s.replayed);
      assert(
        s.transport.prediction.maxDepth <= 12 &&
          s.transport.prediction.peakBytes <= 8 * 1024 * 1024,
      );
      assert(s.frames > 30 && s.renderLimit === 30);
      if (combat)
        assert(
          s.damageEvents > 0 && s.created > 0 && s.destroyed > 0 && s.maxProjectiles > 0,
          JSON.stringify(s),
        );
      if (mixed)
        assert(
          s.interrupted && s.deaths && (carnival ? s.coasterHits > 0 : s.helicopterRemoved > 0),
          JSON.stringify(s),
        );
    }
    if (mixed) assert(states.some((s) => s.replayInterrupted));
    let survivor;
    if (count > 2) {
      await pages[count - 1].close();
      survivor = await Promise.all(pages.slice(0, -1).map((page) => waitTick(page, end + 120)));
      assert(survivor.every((state) => state.confirmed > end + 100));
    }
    const finalRss = rss();
    const hz = ((beforeDeath.confirmed - start.confirmed) * 1000) / (beforeDeath.now - start.now);
    assert(hz >= 28 && hz <= 32, hz);
    await observation.settled();
    assert.deepEqual(errors, []);
    console.log(
      "PASS live roster",
      JSON.stringify({
        count,
        latency,
        jitter,
        mixed,
        combat,
        width,
        height,
        authorityHz: hz,
        initialRss,
        finalRss,
        states,
        survivors: survivor?.map((s) => s.confirmed),
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
