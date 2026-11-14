/* global Module, tm4Port */
const { startDiagnosticGame, togglePanel } = require("./helpers/player.cjs");
const assert = require("node:assert/strict");
const { launchBrowser } = require("./helpers/browser.cjs");

const modes = [
  { name: "Vanilla", step: null, lead: 0 },
  { name: "33.3 ms interpolation", step: 7, lead: 0 },
  { name: "0 ms extrapolation", step: 0, lead: 1 },
  { name: "15 ms mixed motion", step: 3, lead: 1 - 15 / (1000 / 30) },
];

function verifyPhases(phases, mode) {
  assert(phases.length > 50, mode.name + " drew frames");
  assert.equal(phases[0].fraction, 1, "the first frame has no previous sample");
  assert.equal(phases[0].history, false);
  const enabled = mode.step !== null;
  assert(phases.some(({ smoothing }) => smoothing === enabled));
  const sampled = phases.filter(({ history }) => history);
  if (mode.step === null) {
    assert.equal(sampled.length, 0);
    return;
  }
  assert(
    sampled.some(({ fraction }) => fraction !== 1),
    "sub-tick motion was sampled",
  );
  for (const { phase, fraction } of sampled) {
    assert(phase >= 0 && phase <= 1);
    assert(Math.abs(fraction - (phase + mode.lead)) < 1e-8);
  }
  if (mode.step === 3) {
    assert(sampled.some(({ fraction }) => fraction < 1));
    assert(sampled.some(({ fraction }) => fraction > 1));
  }
}

function verifyMotion(samples, mode) {
  const poses = new Map();
  const tickKey = (sample, offset = 0) => `${sample.address}/${sample.id}/${sample.tick + offset}`;
  for (const sample of samples) {
    const key = tickKey(sample);
    if (poses.has(key)) assert.deepEqual(poses.get(key), sample.live, "live pose during draw");
    poses.set(key, sample.live);
    if (!sample.history || mode.step === null) assert.deepEqual(sample.render, sample.live);
  }
  if (mode.step === null) return;
  const wrap = (angle) => ((angle + 2048) & 4095) - 2048;
  const check = (sample) => {
    const previous = poses.get(tickKey(sample, -1));
    if (!sample.history || !previous) return false;
    const { live, render, fraction, pickup } = sample;
    if (pickup && previous[3] !== live[3]) {
      assert(
        Math.abs(wrap(render[3] - live[3]) - (fraction - 1) * wrap(live[3] - previous[3])) <= 1,
      );
      return live[3] !== render[3];
    }
    let moved = false;
    for (let i = 0; i < 3; i++) {
      assert(Math.abs(render[i] - (previous[i] + fraction * (live[i] - previous[i]))) <= 1);
      moved ||= live[i] !== render[i];
    }
    return moved;
  };
  for (const name of ["player car", "camera", "weaponFireball", "pickup"]) {
    const group = samples.filter(
      (sample) => sample.name === name || (name === "pickup" && sample.pickup),
    );
    if (mode.lead > 0 && (name === "player car" || name === "camera"))
      verifyBridge(group, mode, name);
    else assert(group.some(check), mode.name + " sampled " + name);
  }
}

function verifyBridge(samples, mode, name) {
  const byTick = new Map();
  const liveByTick = new Map(samples.map(({ tick, live }) => [tick, live]));
  for (const { tick, history, bridge, live, render } of samples) {
    assert.equal(!!bridge, history, name + " reported its render-only endpoints");
    if (!bridge) continue;
    const { from, to, lead, phase } = bridge;
    assert(phase >= 0 && phase <= 1);
    assert(lead >= 0 && lead <= mode.lead);
    for (let axis = 0; axis < 3; axis++) {
      const expected = from[axis] + phase * (to[axis] - from[axis]);
      assert(Math.abs(render[axis] - expected) <= 0.5, name + " follows the render bridge");
      const last = liveByTick.get(tick - 1);
      if (last) {
        const target = live[axis] + lead * (live[axis] - last[axis]);
        assert(Math.abs(to[axis] - target) <= 0.5, name + " forecasts from live snapshots");
      }
    }
    if (lead === 0) assert.deepEqual(to, live, name + " targets the live pose on contact");
    if (byTick.has(tick)) assert.deepEqual(byTick.get(tick), { from, to, lead });
    byTick.set(tick, { from, to, lead });
  }
  let seams = 0;
  let contacts = 0;
  for (const [tick, { from, lead }] of byTick) {
    const previous = byTick.get(tick - 1);
    if (!previous) continue;
    assert.deepEqual(from, previous.to, name + " is continuous across tick " + tick);
    if (lead === 0) contacts++;
    seams++;
  }
  assert(seams > 60, name + " verified continuous tick boundaries");
  assert(contacts >= 10, name + " kept smoothing during the replay's wall contacts");
  for (const tick of name === "camera" ? [106, 110, 113] : [113]) {
    const cut = samples.filter((sample) => sample.tick === tick);
    assert(cut.length > 0, name + " drew the cut pose");
    assert(
      cut.every(({ history }) => !history),
      name + " dropped history on tick " + tick,
    );
  }
  assert(
    samples.some(
      ({ bridge, live, render }) =>
        bridge?.lead === mode.lead && live.some((value, axis) => value !== render[axis]),
    ),
    name + " reaches the selected prediction lead",
  );
}

(async () => {
  const browser = await launchBrowser({
    headless: process.env.TM4_HEADED !== "1",
    args: ["--disable-frame-rate-limit"],
  });
  const context = await browser.newContext({ viewport: { width: 720, height: 540 } });
  const errors = [];
  try {
    let expected;
    for (const mode of modes) {
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
      await startDiagnosticGame(page);
      await togglePanel(page, "render-settings");
      await page.selectOption("#render-preset", "ps1");
      await page.selectOption("#render-limit", "120");
      if (mode.step !== null) {
        await page.locator("#render-smoothing").check();
        await page.locator("#render-smoothing-delay").fill(String(mode.step));
      }
      await togglePanel(page, "render-settings");
      await page.locator("canvas").click();
      await page.evaluate(() => {
        tm4Port.testMotionSeed = 743;
        tm4Port.testMotionSimulation = [];
        tm4Port.testMotionPhases = [];
        tm4Port.motionSamples = [];
        Module._WebTestCaptureMotion(1);
      });
      const enter = async () => {
        await page.keyboard.down("x");
        await page.waitForTimeout(130);
        await page.keyboard.up("x");
      };
      const menu = (name) =>
        page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
          timeout: 30000,
        });
      await enter();
      await menu("newgame");
      await enter();
      await menu("carsel");
      await enter();
      await page.waitForFunction(
        () => tm4Port.screen === "level" && tm4Port.simulationTicks >= 120,
        null,
        { timeout: 30000 },
      );
      const { phases, simulation, samples } = await page.evaluate(() => ({
        phases: tm4Port.testMotionPhases.slice(),
        simulation: tm4Port.testMotionSimulation.slice(0, 120),
        samples: tm4Port.motionSamples.slice(),
      }));
      verifyPhases(phases, mode);
      verifyMotion(samples, mode);
      assert.equal(simulation.length, 120, "recorded every simulation tick");
      assert(simulation.some(([, , cars]) => cars.some((car) => car.player === 0 && car.steering)));
      if (expected) {
        for (const [index, snapshot] of simulation.entries())
          assert.deepEqual(
            snapshot,
            expected[index],
            mode.name + " gameplay replay at tick " + (index + 1),
          );
      } else expected = simulation;
      const comparison = phases.filter(({ tick }) => tick >= 10 && tick < 120);
      const fps = (comparison.length * 30) / 110;
      console.log(mode.name, { fps, identicalSimulationTicks: simulation.length });

      if (mode.step === 3) {
        await page.evaluate(() => {
          tm4Port.testMotionPhases.length = 0;
          const end = performance.now() + 300;
          while (performance.now() < end) {
            /* simulate a stalled RAF callback */
          }
        });
        await page.waitForFunction(() => tm4Port.testMotionPhases.some(({ history }) => history));
        const [first, ...following] = await page.evaluate(() => tm4Port.testMotionPhases);
        assert.equal(first.history, false, "first frame after a gap has no stale history");
        assert.equal(first.fraction, 1);
        assert(
          following.some(({ history }) => history),
          "fresh history resumes after the gap",
        );
        await togglePanel(page, "render-settings");
        await page.evaluate(() => {
          tm4Port.testMotionPhases.length = 0;
        });
        await page.locator("#render-smoothing-delay").fill("0");
        await page.waitForFunction(() => tm4Port.testMotionPhases.some(({ lead }) => lead === 1));
        const switched = await page.evaluate(() =>
          tm4Port.testMotionPhases.find(({ lead }) => lead === 1),
        );
        assert.equal(switched.history, false, "delay change starts from live poses");
        await page.locator("#render-smoothing").uncheck();
        await page.waitForFunction(() => !tm4Port.renderSmoothing);
        await page.evaluate(() => {
          tm4Port.testMotionPhases.length = 0;
        });
        await page.locator("#render-smoothing").check();
        await page.waitForFunction(() =>
          tm4Port.testMotionPhases.some(({ smoothing }) => smoothing),
        );
        const toggled = await page.evaluate(() =>
          tm4Port.testMotionPhases.find(({ smoothing }) => smoothing),
        );
        assert.equal(toggled.history, false, "reenabling smoothing starts from live poses");
        assert.equal(toggled.lead, 1, "reenabling smoothing restores its delay");
        await togglePanel(page, "render-settings");
        await page.locator("canvas").click();
        await page.keyboard.press("Enter", { delay: 130 });
        await page.waitForFunction(() => tm4Port.paused);
        const paused = await page.evaluate(() => {
          tm4Port.testMotionPhases.length = 0;
          return tm4Port.simulationTicks;
        });
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => tm4Port.simulationTicks), paused);
        await enter();
        await page.waitForFunction(
          (tick) =>
            !tm4Port.paused &&
            tm4Port.simulationTicks > tick &&
            tm4Port.testMotionPhases.some(({ history }) => history),
          paused,
        );
        const resumed = await page.evaluate(() => tm4Port.testMotionPhases[0]);
        assert.equal(resumed.history, false, "resume starts from live poses");
      }
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log("PASS motion phase, reset, sampled poses and 120 identical ticks per setting");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
