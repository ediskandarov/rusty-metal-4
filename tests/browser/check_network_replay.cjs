/* global Module, tm4Port */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
const endpoint = process.env.TM4_MATCH_ENDPOINT;
const token = process.env.TM4_AUTHORITY_TOKEN;
const checkpoint = 96;
const end = 260;

async function ready(page, query) {
  page.on("pageerror", (error) => console.error(error));
  await page.goto(new URL(query, site).href);
  await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
    timeout: 60000,
    polling: 100,
  });
}

async function advance(page, from, to, yieldEvery = 0) {
  return page.evaluate(
    async ({ from, to, yieldEvery }) => {
      const states = [];
      let contact = false;
      for (let tick = from; tick < to; tick++) {
        const steering = tick % 64 < 32 ? 0x8000 : 0x2000;
        if (tick === 60 && Module._WebTestPlaceWeaponTarget(128) <= 0)
          throw new Error("Could not set up car contact");
        if (tick === 110 && Module._WebTestPlaceWeaponTarget(500) <= 0)
          throw new Error("Could not set up projectile target");
        if (tick === 220 && !Module._WebTestApproachCrane(0))
          throw new Error("Could not set up crane control");
        for (let slot = 0; slot < 2; ++slot) {
          let buttons = 0;
          if (tick < 56) buttons = 0x40 | (slot ? steering ^ 0xa000 : steering);
          if (tick >= 64 && slot === 0) buttons = 0x2 | (tick % 12 === 0 ? 0x1 : 0);
          if (tick >= 150 && slot === 1) buttons = 0x40 | steering | 0x2;
          if (tick >= 220 && slot === 0) buttons = 0x2000;
          if (!Module._WebNetSetInput(tick, slot, buttons, 0, 0))
            throw new Error("Input refused at " + tick);
        }
        if (!Module._WebNetQueueTick(tick)) throw new Error("Step refused at " + tick);
        contact ||= !!Module._WebTestNetworkCarContact();
        states.push(structuredClone(tm4Port.netMatch));
        if (yieldEvery && tick % yieldEvery === 0)
          await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        states,
        contact,
        cars: structuredClone(tm4Port.cars),
        bullets: tm4Port.bulletSpawns ?? 0,
        projectiles: tm4Port.projectileSpawns ?? 0,
        impacts: tm4Port.projectileImpacts ?? 0,
        removed: tm4Port.projectileRemoved ?? 0,
        crane: structuredClone(tm4Port.crane),
        voices: Module._WebTestNetworkPlaybackVoices(),
        rendered: tm4Port.levelFrames,
      };
    },
    { from, to, yieldEvery },
  );
}

function compare(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (const [index, state] of actual.entries()) {
    assert.equal(state.unsupported, null, "unsupported at tick " + state.tick);
    assert.deepEqual(state.sections, expected[index].sections, "state at tick " + state.tick);
    assert.equal(state.digest, expected[index].digest);
  }
}

async function canonicalBytes(page) {
  return Buffer.from(
    await page.evaluate(() => {
      if (!Module._WebNetCaptureState()) throw new Error("Canonical state capture refused");
      return Array.from(tm4Port.netCapturedState);
    }),
  );
}

async function direct(browser) {
  const silent = await browser.newPage();
  const rendered = await browser.newPage();
  try {
    await silent.addInitScript(() => {
      window.requestAnimationFrame = () => 0;
    });
    await Promise.all([ready(silent, "?authority=1"), ready(rendered, "?session=1")]);
    await rendered.locator("canvas").click();
    const init = (page, view) =>
      page.evaluate((view) => {
        if (view >= 0 && !Module._WebTestOffsetReplayHeap())
          throw new Error("Could not offset the game's object heap");
        if (!Module._WebNetRequestMatch(2, 0, 12345, view)) throw new Error("Could not initialize");
        return structuredClone(tm4Port.netMatch);
      }, view);
    const initial = await init(silent, -1);
    assert.deepEqual(await init(rendered, 1), initial);
    assert.notEqual(
      await silent.evaluate(() => Module._WebTestReplayCarAddress()),
      await rendered.evaluate(() => Module._WebTestReplayCarAddress()),
    );
    const prefix = await advance(silent, 0, checkpoint);
    assert.equal(
      await silent.evaluate(() => Module._WebTestProjectileCheckpointCallbacks()),
      1,
      "stock projectile callback overrides were not rejected",
    );
    const checkpointBytes = await canonicalBytes(silent);
    const continuation = await advance(silent, checkpoint, end);
    const continuationBytes = await canonicalBytes(silent);
    const expected = prefix.states.concat(continuation.states);
    assert.deepEqual([...new Set(expected.map((state) => state.unsupported))], [null]);
    assert.equal(continuation.rendered, 0);
    assert.equal(continuation.voices, 0);
    assert(
      continuation.crane.controlled && continuation.crane.angle !== 0,
      "Construction Yard crane did not rotate",
    );
    assert(prefix.contact || continuation.contact, "fixture did not yield car contact");
    assert(
      continuation.bullets > 0 &&
        continuation.projectiles > 0 &&
        continuation.impacts > 0 &&
        continuation.removed > 0,
    );
    assert(
      continuation.cars.some((car, index) => car.health < prefix.cars[index].health),
      "no damage during continuation",
    );

    assert.equal(
      await silent.evaluate(() => {
        const before = tm4Port.netMatch.digest;
        Module.FS.rename("/DATA/GAME.MR", "/DATA/GAME.MR.missing");
        try {
          return Module._WebNetBeginReplay() === 0 && tm4Port.netMatch.digest === before;
        } finally {
          Module.FS.rename("/DATA/GAME.MR.missing", "/DATA/GAME.MR");
        }
      }),
      true,
    );
    const rewind = (page) =>
      page.evaluate(() => {
        if (!Module._WebNetBeginReplay()) throw new Error("Replay initialization refused");
        return structuredClone(tm4Port.netMatch);
      });
    const finish = (page) => page.evaluate(() => Module._WebNetEndReplay());
    assert.deepEqual(await rewind(silent), initial);
    compare((await advance(silent, 0, checkpoint)).states, prefix.states);
    assert.deepEqual(await canonicalBytes(silent), checkpointBytes);
    await finish(silent);
    compare((await advance(silent, checkpoint, end)).states, continuation.states);

    await advance(rendered, 0, 19, 3);
    assert.equal(await rendered.evaluate(() => Module._WebTestPerturbNetworkCar(1)), 1);
    assert.notEqual((await advance(rendered, 19, 20)).states[0].digest, expected[19].digest);
    assert.deepEqual(await rewind(rendered), initial);
    compare((await advance(rendered, 0, checkpoint)).states, prefix.states);
    assert.deepEqual(await canonicalBytes(rendered), checkpointBytes);
    await finish(rendered);
    const cross = await advance(rendered, checkpoint, end, 6);
    compare(cross.states, continuation.states);
    assert.deepEqual(await canonicalBytes(rendered), continuationBytes);
    assert(cross.rendered > 0, "playing client did not render during continuation");
    assert(cross.voices > 0, "playing client did not assign playback voices");
    assert.equal(
      await rendered.evaluate(() => Module._WebTestDetonationCheckpointIdentity()),
      1,
      "same-named weapon reassignment did not change state or unresolved reference was accepted",
    );
    assert.equal(
      await rendered.evaluate(() => {
        Module.tm4CodeMods = { size: 1 };
        try {
          return Module._WebNetCaptureState() === 0 && Module._WebNetBeginReplay() === 0;
        } finally {
          delete Module.tm4CodeMods;
        }
      }),
      true,
    );
    console.log(
      "PASS same-instance and cross-instance replay through 260 ticks, with contact, projectiles, damage and crane movement",
    );
  } finally {
    await Promise.all([silent.close(), rendered.close()]);
  }
}

const scenarios = {
  standard: { divergentTick: 151, requestDelay: 0, expected: "recovered" },
  boundary: { divergentTick: 898, requestDelay: 260, expected: "recovered" },
  expired: { divergentTick: 898, requestDelay: 1350, expected: "unavailable" },
  stalled: { divergentTick: 898, requestDelay: 260, expected: "disconnected" },
};

async function network(browser) {
  const scenarioName = process.env.TM4_REPLAY_SCENARIO ?? "standard";
  const scenario = scenarios[scenarioName];
  assert(scenario, "unknown replay scenario");
  const { connectAuthority } = await import("../../tools/network/authority.ts");
  const [authority, altered, survivor] = await Promise.all(
    Array.from({ length: 3 }, () => browser.newPage()),
  );
  let authorityError;
  try {
    await Promise.all([
      ready(authority, "?authority=1"),
      ...[altered, survivor].map((page) => ready(page, "?match=" + encodeURIComponent(endpoint))),
    ]);
    await altered.evaluate(async ({ divergentTick, requestDelay, expected }) => {
      const runtime = await import(new URL("network/tm4_network.js", document.baseURI).href);
      const metrics = (globalThis.tm4ReplayTest = {
        submittedAt: 0,
        began: 0,
        ended: 0,
        replaying: false,
        replaySteps: 0,
        timerTurns: 0,
        suppressedProgress: 0,
      });
      const send = runtime.NetworkClient.prototype.send;
      runtime.NetworkClient.prototype.send = function (json) {
        const { type } = JSON.parse(json);
        if (type === "progress" && expected === "disconnected" && metrics.replaying) {
          metrics.suppressedProgress++;
          return;
        }
        if (type === "recover" && requestDelay) {
          setTimeout(() => {
            metrics.submittedAt = tm4Port.netDiagnostics.receivedFrames;
            send.call(this, json);
          }, requestDelay);
          return;
        }
        return send.call(this, json);
      };

      const begin = Module._WebNetBeginReplay;
      Module._WebNetBeginReplay = () => {
        const result = begin();
        if (result) {
          metrics.replaying = true;
          metrics.began++;
        }
        return result;
      };
      const end = Module._WebNetEndReplay;
      Module._WebNetEndReplay = () => {
        metrics.replaying = false;
        metrics.ended++;
        end();
      };
      setInterval(() => {
        if (metrics.replaying) metrics.timerTurns++;
      }, 10);
      const queue = Module._WebNetQueueTick;
      let injected = false;
      Module._WebNetQueueTick = (tick) => {
        if (metrics.replaying) {
          metrics.replaySteps++;
          if (expected === "disconnected") {
            const until = performance.now() + 6;
            while (performance.now() < until) {
              // Make this replay exceed the server's progress timeout.
            }
          }
        } else if (!injected && tick === divergentTick) {
          if (!Module._WebTestPerturbNetworkCar(1)) throw new Error("Could not perturb car");
          injected = true;
        }
        return queue(tick);
      };
    }, scenario);
    void connectAuthority(authority, endpoint, token).catch((error) => {
      authorityError = error;
    });
    await Promise.all(
      [altered, survivor].map((page) => page.waitForFunction(() => tm4Port.netViewSlot >= 0)),
    );
    if (scenarioName === "standard") {
      await altered.keyboard.down("x");
      await altered.keyboard.down("e");
      await altered.keyboard.down("ArrowLeft");
      await survivor.keyboard.down("x");
      await survivor.keyboard.down("ArrowRight");
    }
    await altered.waitForFunction(
      () =>
        tm4Port.netDiagnostics?.recoveredTick ||
        /diverged|replay|refused|lost the Lightyear connection/i.test(
          document.querySelector("#status").textContent.replace("Restoring the match…", ""),
        ),
      null,
      { timeout: 45000 },
    );
    const result = await altered.evaluate(() => ({
      diagnostics: tm4Port.netDiagnostics,
      metrics: globalThis.tm4ReplayTest,
      status: document.querySelector("#status").textContent,
      local: tm4Port.netMatch,
    }));
    assert.deepEqual(result.diagnostics.divergence, ["cars"]);
    if (scenario.requestDelay)
      assert(result.metrics.submittedAt >= 901, JSON.stringify(result.metrics));
    if (scenario.expected === "recovered") {
      assert(result.diagnostics.recoveredTick > scenario.divergentTick, JSON.stringify(result));
      if (scenarioName === "boundary") assert.equal(result.diagnostics.recoveredTick, 900);
      assert.equal(result.metrics.began, 1);
      assert.equal(result.metrics.ended, 1);
      assert(result.metrics.timerTurns > 0, "no browser events ran during replay");
      assert.equal(result.metrics.replaySteps, result.diagnostics.recoveredTick);
    } else if (scenario.expected === "unavailable") {
      assert(result.metrics.submittedAt >= 931, JSON.stringify(result.metrics));
      assert.match(result.status, /authoritative replay checkpoint is unavailable/i);
      assert.equal(result.metrics.began, 0);
      assert.equal(result.metrics.replaySteps, 0);
    } else {
      assert.match(result.status, /lost the Lightyear connection/i);
      assert.equal(result.metrics.began, 1);
      assert.equal(result.metrics.ended, 1);
      assert(result.metrics.replaySteps > 0 && result.metrics.replaySteps < 900);
      assert(result.metrics.suppressedProgress > 0);
      assert.equal(result.local, undefined);
    }

    const survivorTick = await survivor.evaluate(() => tm4Port.netMatch.tick);
    const pages = scenario.expected === "recovered" ? [altered, survivor] : [survivor];
    await authority.waitForFunction((tick) => tm4Port.netMatch?.tick >= tick, survivorTick + 30);
    for (const page of pages) {
      await page.waitForFunction((tick) => tm4Port.netMatch?.tick >= tick, survivorTick + 30);
      const pair = await page.evaluate(() => [
        tm4Port.netMatch.digest,
        tm4Port.netMatchServerState.digest,
      ]);
      assert.equal(pair[0], pair[1]);
    }
    assert.ifError(authorityError);
    console.log(
      "PASS wire replay",
      scenarioName,
      result.diagnostics.recoveredTick ?? result.status,
      JSON.stringify(result.metrics),
    );
  } finally {
    await Promise.all([authority.close(), altered.close(), survivor.close()]);
  }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: [
      "--enable-unsafe-swiftshader",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  try {
    if (!process.env.TM4_REPLAY_NETWORK_ONLY) await direct(browser);
    if (endpoint && token) await network(browser);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
