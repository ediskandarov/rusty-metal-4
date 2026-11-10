/* global Module, tm4Port */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
const endpoint = process.env.TM4_MATCH_ENDPOINT;
const token = process.env.TM4_AUTHORITY_TOKEN;
const latency = Number(process.env.TM4_LIVE_DELAY_MS ?? 72);
const jitter = Number(process.env.TM4_LIVE_JITTER_MS ?? 12);
const sustain = Number(process.env.TM4_LIVE_SUSTAIN_TICKS ?? 45);
const screenshots = process.env.TM4_LIVE_SCREENSHOT_DIR;
assert(endpoint && token, "A fresh prediction-enabled match server is required");

async function load(page, url) {
  await page.goto(url.href);
  await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
    timeout: 60_000,
    polling: 100,
  });
}

async function instruments(page, client) {
  await page.evaluate(
    async ({ client, latency, jitter }) => {
      const trace = (globalThis.tm4LiveTrace = {
        captures: new Map(),
        fixtures: {},
        hud: new Map(),
        replayedHud: new Set(),
        keys: new Map(),
        firstDrive: null,
        steps: 0,
        publications: 0,
        replay: false,
        repeated: 0,
        contact: false,
        destroyed: false,
        replayDestruction: false,
        replayImpacts: 0,
        damage: false,
      });
      if (client) {
        Module._WebSetRenderLimit(30);
        tm4Port.motionSamples = [];
        Module._WebTestCaptureMotion(1);
        const confirm = Module._WebNetConfirmPresentationTick;
        Module._WebNetConfirmPresentationTick = (tick) => {
          const count = confirm(tick);
          if (count) trace.hud.set(tick, [count, confirm(tick)]);
          return count;
        };
        const bindings = await import(new URL("network/tm4_network.js", document.baseURI).href);
        const update = bindings.NetworkClient.prototype.update;
        bindings.NetworkClient.prototype.update = function () {
          if (this.connected() && !trace.conditioned) {
            this.condition(latency, jitter);
            trace.conditioned = true;
          }
          if (trace.stallUntil > performance.now()) return "[]";
          return update.call(this);
        };
      }
      window.addEventListener("keydown", ({ key }) => trace.keys.set(key, performance.now()), true);
      const restore = Module._WebNetRestoreLocalTick;
      Module._WebNetRestoreLocalTick = (tick) => {
        const restored = restore(tick);
        if (restored) {
          trace.replay = true;
          trace.sceneryAliveAtRestore = trace.world && !!Module._WebTestDestroyablePresent();
        }
        return restored;
      };
      const finish = Module._WebNetFinishLocalReplay;
      Module._WebNetFinishLocalReplay = () => {
        const result = finish();
        trace.replay = false;
        return result;
      };
      const step = Module._WebNetQueueTick;
      Module._WebNetQueueTick = (tick) => {
        const action = trace.fixtures[tick];
        if (action === "contact" && !Module._WebTestPlaceWeaponTarget(128))
          throw new Error("Contact fixture failed");
        if (action === "target" && !Module._WebTestPlaceWeaponTarget(500))
          throw new Error("Projectile fixture failed");
        if (action === "world" && !Module._WebTestAimAtWeakDestroyable())
          throw new Error("World fixture failed");
        if (action === "wall" && !Module._WebTestAimAtDestroyable())
          throw new Error("Wall fixture failed");
        if (action === "world") {
          trace.world = true;
          trace.worldTick = tick;
        }
        if (client && tick >= trace.worldTick + 3 && tick < trace.worldTick + 20) {
          Module._WebTestNetworkHudMessages(1, trace.replay ? 1 : 2);
          if (trace.replay) trace.replayedHud.add(tick + 1);
        }
        const publishes = tm4Port.netMatchTick;
        tm4Port.netMatchTick = () => {
          ++trace.publications;
          publishes?.();
        };
        const previousImpacts = tm4Port.projectileImpacts ?? 0;
        const previousHealth = tm4Port.cars?.map(({ health }) => health);
        let result;
        try {
          result = step(tick);
        } finally {
          tm4Port.netMatchTick = publishes;
        }
        if (!result) return result;
        ++trace.steps;
        if (trace.replay) {
          ++trace.repeated;
          trace.replayImpacts += (tm4Port.projectileImpacts ?? 0) - previousImpacts;
        }
        trace.damage ||=
          !!previousHealth &&
          tm4Port.cars?.some(({ health }, index) => health < previousHealth[index]);
        const { digest, sections } = tm4Port.netMatch;
        if (!client) {
          if (trace.captures.size === 512)
            trace.captures.delete(trace.captures.keys().next().value);
          trace.captures.set(tick + 1, {
            digest,
            sections,
            time: performance.timeOrigin + performance.now(),
          });
        }
        trace.contact ||= !!Module._WebTestNetworkCarContact();
        if (trace.world && !Module._WebTestDestroyablePresent()) {
          trace.destroyed = true;
          trace.replayDestruction ||= trace.replay && trace.sceneryAliveAtRestore;
        }
        const slot = tm4Port.netViewSlot;
        const car = tm4Port.cars?.[slot];
        if (
          client &&
          trace.keys.has("x") &&
          !trace.firstDrive &&
          !trace.replay &&
          car?.throttle > 0
        ) {
          trace.firstDrive = {
            tick: tick + 1,
            confirmed: tm4Port.netConfirmedTick ?? 0,
            latencyMs: performance.now() - trace.keys.get("x"),
            time: performance.timeOrigin + performance.now(),
          };
        }
        return result;
      };
    },
    { client, latency, jitter },
  );
}

async function sceneColors(page, name) {
  const png = await page.screenshot(screenshots ? { path: screenshots + "/" + name + ".png" } : {});
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = "data:image/png;base64," + base64;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 100;
    const context = canvas.getContext("2d");
    context.drawImage(
      image,
      image.width / 4,
      image.height / 4,
      image.width / 2,
      image.height / 2,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 4)
      colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    return colors.size;
  }, png.toString("base64"));
}

const summary = (page) =>
  page.evaluate(() => ({
    status: document.querySelector("#status")?.textContent,
    slot: tm4Port.netViewSlot,
    head: tm4Port.netMatch?.tick,
    confirmed: tm4Port.netConfirmedTick,
    server: tm4Port.netMatchServerState,
    transport: tm4Port.netDiagnostics?.transport,
    cost: tm4Port.netPredictionCost,
    audio: {
      starts: tm4Port.predictionSoundStarts,
      duringReplay: tm4Port.predictionReplaySoundStarts ?? 0,
      reused: tm4Port.rollbackVoicesReused ?? 0,
    },
    frames: tm4Port.levelFrames,
    presentation: tm4Port.networkMotion,
    firstDrive: globalThis.tm4LiveTrace.firstDrive,
    contact: globalThis.tm4LiveTrace.contact,
    destroyed: globalThis.tm4LiveTrace.destroyed,
    damage: globalThis.tm4LiveTrace.damage,
    replayDestruction: globalThis.tm4LiveTrace.replayDestruction,
    replayImpacts: globalThis.tm4LiveTrace.replayImpacts,
    steps: globalThis.tm4LiveTrace.steps,
    repeated: globalThis.tm4LiveTrace.repeated,
    publications: globalThis.tm4LiveTrace.publications,
    bullets: tm4Port.bulletSpawns ?? 0,
    projectiles: tm4Port.projectileSpawns ?? 0,
    impacts: tm4Port.projectileImpacts ?? 0,
    removed: tm4Port.projectileRemoved ?? 0,
  }));

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: [
      "--enable-unsafe-swiftshader",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-frame-rate-limit",
    ],
  });
  const [authority, ...players] = await Promise.all(
    Array.from({ length: 3 }, () => browser.newPage({ viewport: { width: 1280, height: 800 } })),
  );
  const errors = [];
  for (const page of [authority, ...players])
    page.on("pageerror", (error) => errors.push(error.message));
  try {
    await authority.addInitScript(() => {
      window.requestAnimationFrame = () => 0;
    });
    await load(authority, new URL("?authority=1", site));
    await instruments(authority, false);
    const { connectAuthority } = await import("../../tools/network/authority.ts");
    let authorityError;
    void connectAuthority(authority, endpoint, token).catch((error) => {
      authorityError = error;
    });
    const target = new URL(site);
    target.searchParams.set("match", endpoint);
    await load(players[0], target);
    await instruments(players[0], true);
    const waiting = players[0].locator('#status[data-match-state="lobby"]');
    await waiting.filter({ hasText: "Waiting for the other players" }).waitFor();
    assert(await waiting.isVisible());
    await load(players[1], target);
    await instruments(players[1], true);
    const waitConfirmed = (page, targetTick, timeout = 12_000) =>
      page.waitForFunction((tick) => (tm4Port.netConfirmedTick ?? 0) >= tick, targetTick, {
        timeout,
      });
    await Promise.all(players.map((page) => waitConfirmed(page, 35)));
    const colors = [];
    for (const player of players) {
      await player.bringToFront();
      assert(await player.locator('#status[data-match-state="playing"]').isVisible());
      const count = await sceneColors(player, "opening-" + colors.length);
      assert(count > 64, "The gameplay scene is blank or flat (" + count + " colors)");
      colors.push(count);
    }
    const initial = await Promise.all(players.map(summary));
    assert.deepEqual(initial.map(({ slot }) => slot).sort(), [0, 1]);
    const shooter = players[initial.findIndex(({ slot }) => slot === 0)];
    const remoteDriver = players.find((player) => player !== shooter);
    await shooter.evaluate(() => Module._WebSetRenderLimit(60));

    for (const player of players) {
      await player.bringToFront();
      await player.locator("canvas").focus();
      await player.keyboard.down("x");
      await player.waitForFunction(() => globalThis.tm4LiveTrace.firstDrive, null, {
        timeout: 3500,
      });
      const { firstDrive } = await summary(player);
      assert(firstDrive.latencyMs < 100, JSON.stringify(firstDrive));
      assert(firstDrive.tick > firstDrive.confirmed, JSON.stringify(firstDrive));
      await authority.waitForFunction(
        (tick) => globalThis.tm4LiveTrace.captures.has(tick),
        firstDrive.tick,
        { polling: 100, timeout: 4000 },
      );
      const committed = await authority.evaluate(
        (tick) => globalThis.tm4LiveTrace.captures.get(tick).time,
        firstDrive.tick,
      );
      assert(firstDrive.time < committed, "The authority completed the predicted drive tick first");
      await player.waitForTimeout(100);
      await player.keyboard.up("x");
    }

    await shooter.bringToFront();
    await shooter.locator("canvas").focus();
    await shooter.keyboard.down("x");
    await shooter.waitForTimeout(450);
    await shooter.evaluate(() => {
      Module._WebSetRenderLimit(120);
      globalThis.tm4LiveTrace.fastDraw = [tm4Port.levelFrames, performance.now()];
    });
    await shooter.waitForTimeout(220);
    await shooter.keyboard.down("ArrowRight");
    await shooter.waitForTimeout(140);
    await shooter.keyboard.up("ArrowRight");
    await shooter.keyboard.down("ArrowLeft");
    await shooter.waitForTimeout(220);
    await shooter.keyboard.up("ArrowLeft");
    await shooter.keyboard.up("x");
    const fastDraw = await shooter.evaluate(() => {
      const [firstFrame, firstTime] = globalThis.tm4LiveTrace.fastDraw;
      const lastFrame = tm4Port.levelFrames;
      globalThis.tm4LiveTrace.fastDraw.push(lastFrame);
      Module._WebSetRenderLimit(60);
      return (1000 * (lastFrame - firstFrame)) / (performance.now() - firstTime);
    });

    const fixture = async (action, lead = 15) => {
      const tick = await authority.evaluate((lead) => tm4Port.netMatch.tick + lead, lead);
      await Promise.all(
        [authority, ...players].map((page) =>
          page.evaluate(
            ([tick, action]) => {
              globalThis.tm4LiveTrace.fixtures[tick] = action;
            },
            [tick, action],
          ),
        ),
      );
      return tick;
    };
    const tracking = await fixture("target");
    await Promise.all(players.map((page) => waitConfirmed(page, tracking + 2)));
    await remoteDriver.bringToFront();
    await remoteDriver.locator("canvas").focus();
    await remoteDriver.keyboard.down("x");
    await remoteDriver.keyboard.down("ArrowRight");
    await remoteDriver.waitForTimeout(340);
    await remoteDriver.keyboard.up("ArrowRight");
    await remoteDriver.keyboard.up("x");

    const contact = await fixture("contact");
    await Promise.all(players.map((page) => waitConfirmed(page, contact + 8)));
    const targetTick = await fixture("target");
    await Promise.all(players.map((page) => waitConfirmed(page, targetTick + 2)));
    await shooter.bringToFront();
    await shooter.locator("canvas").focus();
    await shooter.keyboard.down("w");
    await shooter.waitForTimeout(180);
    await shooter.keyboard.up("w");
    await authority.waitForFunction(() => tm4Port.projectileRemoved > 0, null, {
      timeout: 8000,
      polling: 100,
    });
    const world = await fixture("world");
    await Promise.all(players.map((page) => waitConfirmed(page, world + 2)));
    await shooter.keyboard.down("e");
    await authority.waitForFunction(() => globalThis.tm4LiveTrace.destroyed, null, {
      timeout: 12_000,
      polling: 100,
    });
    await shooter.keyboard.up("e");
    const destroyed = await summary(authority);
    await Promise.all(players.map((page) => waitConfirmed(page, destroyed.head + sustain)));

    const validate = async (page) => {
      const local = await summary(page);
      const expected = await authority.evaluate(
        (tick) => globalThis.tm4LiveTrace.captures.get(tick),
        local.confirmed,
      );
      assert.deepEqual(local.server.sections, expected.sections);
      assert.equal(local.server.digest, expected.digest);
      assert(local.frames > 0 && local.contact && local.destroyed);
      assert(local.transport.prediction.rollbacks > 0 && local.repeated > 0);
      assert(
        local.transport.prediction.maxDepth <= 12 &&
          local.transport.prediction.peakBytes < 9 * 1024 * 1024,
      );
      assert.equal(local.publications, local.steps - local.repeated);
      assert.equal(local.audio.duringReplay, 0);
      assert(local.audio.starts > 0);
      return local;
    };
    const verified = await Promise.all(players.map(validate));
    const hud = await Promise.all(
      players.map((player) =>
        player.evaluate(() => {
          const { hud, replayedHud } = globalThis.tm4LiveTrace;
          return [...replayedHud].sort((a, b) => a - b).map((tick) => [tick, hud.get(tick)]);
        }),
      ),
    );
    assert(hud[1].length, "Expected at least one corrected HUD tick");
    assert(
      hud[0].every(([, count]) => !count),
      "A HUD event leaked to the other slot",
    );
    for (const [, count] of hud[1])
      assert.deepEqual(count, [1, 0], "Only the corrected HUD event may display, once");
    const motion = await Promise.all(
      players.map((player) =>
        player.evaluate(() => {
          const samples = tm4Port.motionSamples;
          const changed = ({ live, render }) => live.some((value, i) => value !== render[i]);
          const remote = samples.filter(({ name }) => name === "remote car");
          const within = remote.filter(
            ({ fraction, history }) => fraction > 0 && fraction < 1 && history,
          );
          const replayedPoses = samples.filter(
            ({ name }) => name === "player car" || name === "camera",
          );
          const intermediate = (rows) =>
            rows.some(
              (row, i) =>
                i &&
                rows[i - 1].tick === row.tick &&
                rows[i - 1].id === row.id &&
                rows[i - 1].frame !== row.frame &&
                rows[i - 1].render.some((value, axis) => value !== row.render[axis]),
            );
          const localForward = replayedPoses.filter((row) => !row.correction && !row.forwardBlock);
          const fast = globalThis.tm4LiveTrace.fastDraw;
          const split = (name, faster) =>
            localForward.filter(
              ({ name: object, frame }) =>
                object === name &&
                (faster ? fast && frame >= fast[0] && frame < fast[2] : !fast || frame < fast[0]),
            );
          return {
            remoteSamples: remote.length,
            remoteInterpolated: within.filter(changed).length,
            remoteTurned: within.filter(({ live, render }) => live[3] !== render[3]).length,
            localCorrections: replayedPoses.filter((row) => row.correction && changed(row)).length,
            local60: ["player car", "camera"].map((name) => intermediate(split(name, false))),
            local120: ["player car", "camera"].map((name) => intermediate(split(name, true))),
            maxForward: Math.max(
              0,
              ...localForward.map(({ render, live }) =>
                Math.max(...render.slice(0, 3).map((value, axis) => Math.abs(value - live[axis]))),
              ),
            ),
            steeringCuts: replayedPoses.filter(({ forwardBlock }) => forwardBlock & 2).length,
            forwardDuringCut: replayedPoses.some(
              (row) => row.forwardBlock && !row.correction && changed(row),
            ),
            objectMotion: [...new Set(samples.filter(changed).map(({ name }) => name))].sort(),
            intermediateFrames: within.some(
              (sample, i) =>
                i &&
                within[i - 1].tick === sample.tick &&
                within[i - 1].id === sample.id &&
                within[i - 1].frame !== sample.frame &&
                within[i - 1].render.some((value, axis) => value !== sample.render[axis]),
            ),
          };
        }),
      ),
    );
    assert(motion[0].remoteInterpolated > 0, JSON.stringify(motion));
    assert(motion[0].intermediateFrames, JSON.stringify(motion));
    assert(fastDraw > 70, "120 FPS setting produced only " + fastDraw.toFixed(1) + " FPS");
    assert.deepEqual(
      motion[0].local60,
      [true, true],
      "Missing local car or camera sub-tick poses at 60 FPS",
    );
    assert.deepEqual(
      motion[0].local120,
      [true, true],
      "Missing local car or camera sub-tick poses at 120 FPS",
    );
    assert(
      motion[0].steeringCuts > 0 && !motion[0].forwardDuringCut && motion[0].maxForward <= 96,
      JSON.stringify(motion),
    );
    assert(
      motion.some(({ localCorrections }) => localCorrections > 0),
      JSON.stringify(motion),
    );
    assert(
      motion.some(({ objectMotion }) => objectMotion.includes("bullet head")),
      JSON.stringify(motion),
    );
    const steadyColors = await sceneColors(shooter, "smoothed");
    assert(steadyColors > 64, "The smoothed scene is blank");
    const wall = await fixture("wall");
    await waitConfirmed(shooter, wall + 1);
    await shooter.keyboard.down("x");
    await shooter.waitForFunction(() => !!Module._WebTestNetworkWallContact(0), null, {
      timeout: 6000,
    });
    await shooter.waitForFunction(
      (tick) =>
        tm4Port.motionSamples.some(
          (row) =>
            row.tick > tick &&
            row.name === "player car" &&
            row.forwardBlock & 1 &&
            !row.correction &&
            row.live.every((value, i) => value === row.render[i]),
        ),
      wall,
    );
    await shooter.keyboard.up("x");
    const disabled = await shooter.evaluate(() => {
      tm4Port.motionSamples = [];
      Module._WebSetRenderSmoothing(0);
      return tm4Port.netConfirmedTick;
    });
    await waitConfirmed(shooter, disabled + 12);
    await validate(shooter);
    assert(
      await shooter.evaluate(
        () =>
          tm4Port.motionSamples.length > 0 &&
          tm4Port.motionSamples.every(({ live, render }) =>
            live.every((value, i) => value === render[i]),
          ),
      ),
      "Disabling render smoothing must show live poses",
    );
    assert(
      verified.some((state) => state.replayDestruction),
      "No rendered rollback replayed the scenery destruction",
    );
    assert(
      destroyed.bullets > 0 &&
        destroyed.projectiles > 0 &&
        destroyed.impacts > 0 &&
        destroyed.removed > 0,
    );
    assert(destroyed.contact && destroyed.destroyed && destroyed.damage);

    const [stalled, survivor] = players;
    const before = await summary(authority);
    await stalled.evaluate(() => {
      globalThis.tm4LiveTrace.stallUntil = performance.now() + 1000;
    });
    await stalled.waitForFunction(() => !tm4Port.netMatch, null, { timeout: 7000 });
    const stalledState = await summary(stalled);
    assert.match(stalledState.status, /retained|resynchronized|simulation timeline|confirmation/);
    await waitConfirmed(survivor, before.head + 35);
    const after = await validate(survivor);
    const now = await summary(authority);
    const rate = await authority.evaluate(
      ([from, through]) => {
        const rows = globalThis.tm4LiveTrace.captures;
        return (1000 * (through - from)) / (rows.get(through).time - rows.get(from).time);
      },
      [before.head, now.head],
    );
    assert(rate > 27 && rate < 33, "Authority advanced at " + rate);
    const late = await browser.newPage();
    try {
      await late.goto(target.href);
      const error = late.locator('#status[data-match-state="error"]');
      await error
        .filter({ hasText: "This match has already started" })
        .waitFor({ timeout: 60_000 });
      assert(await error.isVisible());
    } finally {
      await late.close();
    }
    await stalled.bringToFront();
    const restart = await stalled.evaluate(async () => {
      const retained = Module._WebNetLocalCheckpointStorageBytes();
      const ready =
        Module._WebNetEnableRenderedPrediction() && Module._WebNetRequestMatch(2, 0, 12345, 0);
      if (!ready) throw new Error("Could not restart rendered C fixture");
      globalThis.tm4LiveTrace.fixtures = {};
      globalThis.tm4LiveTrace.world = false;
      Module._WebSetRenderSmoothing(1);
      const step = (tick, buttons) => {
        if (
          !Module._WebNetSetInput(tick, 0, buttons, 0, 0) ||
          !Module._WebNetSetInput(tick, 1, 0, 0, 0) ||
          !Module._WebNetQueueTick(tick)
        )
          throw new Error("Could not advance correction fixture");
      };
      for (let tick = 0; tick < 14; ++tick) step(tick, 0x40);
      if (!Module._WebNetRetainLocalCheckpoint(14))
        throw new Error("Could not retain correction fixture");
      const run = (buttons) => {
        for (let tick = 14; tick < 21; ++tick) step(tick, buttons);
      };
      const replay = (buttons) => {
        if (!Module._WebNetRestoreLocalTick(14))
          throw new Error("Could not restore correction fixture");
        run(buttons);
        const result = Module._WebNetFinishLocalReplay();
        if (!result) throw new Error("Could not finish correction fixture");
        return result;
      };
      const read = async (weight, phase = 0.5) => {
        tm4Port.motionSamples = [];
        Module._WebNetSetPresentationPhase(phase, weight);
        await new Promise((resolve) => setTimeout(resolve, 70));
        return ["player car", "camera"].map((name) =>
          tm4Port.motionSamples.findLast((sample) => sample.name === name),
        );
      };
      run(0x40);
      const original = await read(0, 0.75);
      const originalDigest = tm4Port.netMatch.digest;
      const noOpResult = replay(0x40);
      const noOp = await read(1, 0.75);
      const noOpDigest = tm4Port.netMatch.digest;
      const constantSpeed = [0, 0.25, 0.5, 0.75].map((phase) =>
        Module._WebTestNetworkForecastStep(80, phase),
      );
      constantSpeed.push(80 + Module._WebTestNetworkForecastStep(80, 0));
      const maxForward = Module._WebTestNetworkForecastStep(140, 1) - 140;
      Module._WebNetSetPresentationPhase(0.5, 0);
      replay(0x8040);
      const first = await read(0.65);
      replay(0x2040);
      const overlapping = await read(1);
      const settled = await read(0, 0);
      Module._WebNetCancelMatch();
      return {
        retained,
        ready,
        closed: !tm4Port.netMatch,
        first,
        overlapping,
        settled,
        original,
        originalDigest,
        noOpResult,
        noOp,
        noOpDigest,
        constantSpeed,
        maxForward,
      };
    });
    assert.equal(restart.retained, 0);
    assert.equal(restart.ready, 1);
    assert(restart.closed);
    assert.equal(restart.noOpResult, 1);
    assert.equal(restart.noOpDigest, restart.originalDigest);
    assert.deepEqual(
      restart.noOp.map(({ render }) => render),
      restart.original.map(({ render }) => render),
    );
    assert(
      restart.original.every(({ render, live }) => render.some((value, i) => value !== live[i])),
    );
    assert.deepEqual(restart.constantSpeed, [80, 100, 120, 140, 160]);
    assert.equal(restart.maxForward, 96);
    assert(restart.first.some((sample) => sample.correction));
    assert(restart.overlapping.some((sample) => sample.correction));
    for (let i = 0; i < 2; ++i) {
      assert(
        restart.first[i].render.every(
          (value, axis) => Math.abs(value - restart.overlapping[i].render[axis]) <= 3,
        ),
        JSON.stringify(restart),
      );
      assert.deepEqual(restart.settled[i].render, restart.settled[i].live);
    }
    assert.ifError(authorityError);
    assert.deepEqual(errors, []);
    console.log(
      "PASS live Lightyear rollback",
      JSON.stringify({
        latency,
        jitter,
        colors,
        hud,
        motion,
        steadyColors,
        fastDraw,
        noOpDigest: restart.noOpDigest,
        constantSpeed: restart.constantSpeed,
        overlap: restart.overlapping.map(({ name, live, render }) => ({ name, live, render })),
        verified,
        survivor: after.confirmed,
        authorityHz: rate,
        stalled: stalledState.status,
        authorityCombat: {
          bullets: destroyed.bullets,
          projectiles: destroyed.projectiles,
          impacts: destroyed.impacts,
          removed: destroyed.removed,
        },
      }),
    );
  } catch (error) {
    console.error("LIVE ASSERTION", error);
    console.error(
      "LIVE STATES",
      await Promise.all([authority, ...players].map((page) => summary(page).catch(String))),
    );
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
