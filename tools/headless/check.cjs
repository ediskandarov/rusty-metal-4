const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { createMatch } = require("./host.cjs");
(async () => {
  const [modulePath, resources, referencePath, output = "build/headless-result.json"] =
    process.argv.slice(2);
  const reference = JSON.parse(readFileSync(referencePath));
  const match = await createMatch({ modulePath, resources });
  const tm4Port = globalThis.tm4Port;
  const compare = (state) => {
    const expected = reference.rows[state.tick];
    assert.equal(state.unsupported, null);
    assert.equal(state.digest, expected.digest, `tick ${state.tick} digest`);
    assert.deepEqual(state.sections, expected.sections, `tick ${state.tick} subsystems`);
    assert.equal(
      state.bytes.toString("base64"),
      expected.canonical,
      `tick ${state.tick} canonical bytes`,
    );
  };
  const step = (tick) => {
    const { action, inputs } = reference.tape[tick];
    if (action) assert(match.engine[action[0]](action[1]), `fixture ${tick}`);
    const start = performance.now();
    const state = match.step(inputs);
    return { state, ms: performance.now() - start };
  };
  compare(match.read());
  const stepMs = [];
  let checkpointBytes = 0;
  let captureMs = 0;
  const checkpointTick = 82;
  assert(reference.events[checkpointTick - 1].live.length, "checkpoint needs a live projectile");
  for (let tick = 0; tick < reference.rows.length - 1; tick++) {
    const { state, ms } = step(tick);
    stepMs.push(ms);
    compare(state);
    if (state.tick === checkpointTick) {
      const start = performance.now();
      checkpointBytes = match.save();
      captureMs = performance.now() - start;
    }
  }
  match.engine._WebTestLocalCheckpointProjectiles();
  const events = {
    live: tm4Port.testLiveProjectiles,
    spawned: tm4Port.projectileSpawns || 0,
    removed: tm4Port.projectileRemoved || 0,
    impacts: tm4Port.projectileImpacts || 0,
  };
  assert.deepEqual(events, reference.events.at(-1), "projectile creation/removal parity");
  assert(events.spawned > 0 && events.removed > 0 && events.impacts > 0, "combat coverage");
  assert.equal(tm4Port.levelFrames, 0, "no rendered frames");
  const replay = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const start = performance.now();
    compare(match.restore());
    const restoreMs = performance.now() - start;
    const replayStart = performance.now();
    for (let tick = checkpointTick; tick < reference.rows.length - 1; tick++)
      compare(step(tick).state);
    replay.push({ restoreMs, replayMs: performance.now() - replayStart });
    match.finishReplay();
  }
  const result = {
    browserFree: !globalThis.document && !globalThis.window,
    ticks: stepMs.length,
    canonicalComparisons: 1 + stepMs.length + 3 * (reference.rows.length - checkpointTick),
    startupMs: match.startupMs,
    stepMs,
    checkpointBytes,
    captureMs,
    replay,
    events,
    processMemory: process.memoryUsage(),
    runtime: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  match.destroy();
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      ...result,
      stepMs: {
        min: Math.min(...stepMs),
        max: Math.max(...stepMs),
        mean: stepMs.reduce((a, b) => a + b, 0) / stepMs.length,
      },
    }),
  );
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
