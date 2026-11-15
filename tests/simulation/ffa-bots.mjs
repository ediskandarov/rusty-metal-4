/* Original-AI replay checks against actual game Wasm and stock map resources. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WASI } from "node:wasi";

const compiled = await WebAssembly.compile(fs.readFileSync(process.env.TM4_SIMULATION_WASM));
async function simulation(bot = true, configuration = {}) {
  const slots = configuration.slots ?? [0, 1];
  const bots = configuration.bots ?? (bot ? [1] : []);
  const cars = configuration.cars ?? slots.map((_, index) => (index % 2 ? "Pizza Boy" : "Orbital"));
  const pool = configuration.pool ?? ["Orbital", "Pizza Boy"];
  const wasi = new WASI({
    version: "preview1",
    preopens: { "/DATA": join(process.env.TM4_RESOURCE_DIR, "DATA") },
    returnOnExit: true,
  });
  const instance = await WebAssembly.instantiate(compiled, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  wasi.initialize(instance);
  const x = instance.exports;
  const bytes = () => new Uint8Array(x.memory.buffer);
  const string = (address) => {
    let end = address;
    while (bytes()[end]) ++end;
    return new TextDecoder().decode(bytes().subarray(address, end));
  };
  const arg = (value) => {
    const data = new TextEncoder().encode(value + "\0");
    const address = x.malloc(data.length);
    bytes().set(data, address);
    return address;
  };
  assert.equal(x.HeadlessInitialize(), 1);
  const args = [
    arg(cars.join("\n")),
    arg(slots.map((slot) => (slot + 1).toString(16).padStart(16, "0")).join("\n")),
    arg(pool.join("\n")),
  ];
  assert.equal(
    x.WebNetStartFfa(
      8,
      slots.reduce((mask, slot) => mask | (1 << slot), 0),
      0,
      12345,
      -1,
      1,
      args[0],
      args[1],
      12,
      args[2],
      27000,
      100,
      bots.reduce((mask, slot) => mask | (1 << slot), 0),
    ),
    1,
  );
  args.forEach((address) => x.free(address));
  const read = (address, length) => Buffer.from(bytes().subarray(address, address + length));
  return {
    x,
    ai(field, slot = 1) {
      return x.WebTestAiState(slot, field);
    },
    step(buttons = 0) {
      const tick = x.HeadlessTick();
      for (let slot = 0; slot < 8; ++slot)
        if (x.WebNetSlotMask() & (1 << slot))
          assert.equal(
            x.WebNetSetInput(
              tick,
              slot,
              Array.isArray(buttons) ? (buttons[slot] ?? 0) : slot === 0 ? buttons : 0,
              0x80808080,
              0,
            ),
            1,
          );
      assert.equal(x.WebNetQueueTick(tick), 1);
    },
    canonical() {
      const length = x.HeadlessCapture();
      assert.ok(length, string(x.HeadlessError()));
      return read(x.HeadlessCanonical(), length);
    },
    results(slot) {
      const offset = x.HeadlessParticipants() + slot * 16;
      const view = new DataView(x.memory.buffer);
      return [
        view.getBigUint64(offset, true),
        view.getInt32(offset + 8, true),
        view.getInt32(offset + 12, true),
      ];
    },
    snapshot() {
      const length = x.HeadlessPortableCapture();
      assert.ok(length, string(x.HeadlessError()));
      return read(x.HeadlessPortableBuffer(), length);
    },
    restore(snapshot) {
      bytes().set(snapshot, x.HeadlessPortableBuffer());
      assert.equal(x.HeadlessPortableRestore(snapshot.length), 1, string(x.HeadlessError()));
    },
  };
}

test("one human and one original AI retain identical canonical state at every replay tick", async () => {
  const world = await simulation();
  assert.equal(world.ai(0), 2); // CAR_CONTROL_ENEMY; no ally health policy.
  assert.equal(world.ai(9), 1, "both map navigation and character AI settings enabled");
  for (let i = 0; i < 30; ++i) world.step();
  const snapshot = world.snapshot();
  const before = world.canonical();
  assert.ok(world.x.WebNetCaptureLocalCheckpoint());
  const observations = new Set();
  const checkpoints = [];
  let targets = 0,
    routes = 0,
    weapons = 0,
    projectileTicks = 0,
    nearby = 0,
    savedStates = 0;
  const action = (current, tick) => {
    if ([80, 190, 330, 540, 650].includes(tick))
      assert.equal(current.x.WebTestPlacePlayerTarget(1, 0, 1200, 0), 1);
    if (tick === 120) assert.equal(current.x.WebTestAiRecovery(1), 1);
    if (tick === 230) assert.equal(current.x.WebTestKillParticipant(0), 1);
    if (tick === 480) assert.equal(current.x.WebTestKillParticipant(1), 1);
  };
  const expected = [];
  const started = performance.now();
  for (let tick = 0; tick < 700; ++tick) {
    action(world, tick);
    world.step(tick % 120 < 60 ? 0x4000 : 0);
    expected.push(world.canonical());
    if (tick === 230) {
      assert.equal(world.ai(4), 0);
      assert.equal(world.ai(13), 0);
      assert.equal(world.ai(12), 0);
    }
    if ([100, 120, 240, 500].includes(tick))
      checkpoints.push({ tick: tick + 1, snapshot: world.snapshot(), state: world.canonical() });
    observations.add(world.ai(1));

    targets += world.ai(4) > 0;
    routes += world.ai(2) > 1;
    weapons += world.ai(17) > 0;
    projectileTicks += world.ai(24) > 0;
    nearby += world.ai(12) > 0;
    savedStates += world.ai(11) > 0;
  }
  const stepMs = performance.now() - started;
  assert.equal(world.x.WebNetRestoreLocalCheckpoint(30), 1);
  assert.deepEqual(world.canonical(), before);
  for (let tick = 0; tick < expected.length; ++tick) {
    action(world, tick);
    world.step(tick % 120 < 60 ? 0x4000 : 0);
    assert.deepEqual(world.canonical(), expected[tick], `local replay tick ${tick}`);
  }
  const portable = await simulation();
  portable.restore(snapshot);
  assert.deepEqual(portable.canonical(), before);
  for (let tick = 0; tick < expected.length; ++tick) {
    action(portable, tick);
    portable.step(tick % 120 < 60 ? 0x4000 : 0);
    assert.deepEqual(portable.canonical(), expected[tick], `separate-instance replay tick ${tick}`);
  }

  for (const checkpoint of checkpoints) {
    const restored = await simulation();
    restored.restore(checkpoint.snapshot);
    assert.deepEqual(restored.canonical(), checkpoint.state);
    for (let tick = checkpoint.tick; tick < expected.length; ++tick) {
      action(restored, tick);
      restored.step(tick % 120 < 60 ? 0x4000 : 0);
      assert.deepEqual(restored.canonical(), expected[tick], "active portable replay tick " + tick);
    }
  }
  if (process.env.TM4_BOT_REFERENCE) {
    fs.mkdirSync(join(process.env.TM4_BOT_REFERENCE, ".."), { recursive: true });
    fs.writeFileSync(
      process.env.TM4_BOT_REFERENCE,
      JSON.stringify({
        snapshot: snapshot.toString("base64"),
        before: before.toString("base64"),
        rows: expected.map((row) => row.toString("base64")),
      }),
    );
  }
  assert.ok(weapons > 0, "original AI fired a weapon");
  assert.ok(projectileTicks > 0, "original AI created participant-attributed projectile objects");
  assert.ok(savedStates > 0, "original obstacle recovery retained its previous state callback");
  console.log({
    states: [...observations],
    targets,
    routes,
    weapons,
    projectileTicks,
    nearby,
    savedStates,
    snapshotBytes: snapshot.length,
    stepMs,
  });
  assert.ok(routes > 0, "original AI selected navigation routes");
  assert.ok(targets > 0, "original AI acquired the human target");
});

test("all three original navigation searches rewind their shared mutable resource state", async () => {
  const world = await simulation();
  for (let i = 0; i < 30; ++i) world.step();
  const start = world.ai(5),
    end = world.x.WebTestAiState(0, 5);
  assert.ok(start >= 0 && end >= 0);
  assert.ok(world.x.WebNetCaptureLocalCheckpoint());
  const snapshot = world.snapshot();
  const before = world.canonical();
  const expected = [];
  for (let i = 0; i < 180; ++i) {
    assert.ok(world.x.WebTestAiSearch(i % 3, start, end) >= 0);
    expected.push(world.canonical());
  }
  assert.equal(world.x.WebNetRestoreLocalCheckpoint(30), 1);
  assert.deepEqual(world.canonical(), before);
  for (let i = 0; i < expected.length; ++i) {
    world.x.WebTestAiSearch(i % 3, start, end);
    assert.deepEqual(world.canonical(), expected[i], `local navigation search ${i}`);
  }
  const portable = await simulation();
  portable.restore(snapshot);
  assert.deepEqual(portable.canonical(), before);
  for (let i = 0; i < expected.length; ++i) {
    portable.x.WebTestAiSearch(i % 3, start, end);
    assert.deepEqual(portable.canonical(), expected[i], `portable navigation search ${i}`);
  }
});

test("focused two-human CPU and snapshot comparison with explicit bot rosters", async () => {
  const measurements = [];
  for (const bots of [[], [2, 3, 4], [2, 3, 4, 5, 6, 7]]) {
    const world = await simulation(false, { slots: [0, 1, ...bots], bots });
    for (let i = 0; i < 60; ++i) world.step();
    const started = performance.now();
    for (let i = 0; i < 300; ++i) world.step();
    measurements.push({
      humans: 2,
      bots: bots.length,
      ticks: 300,
      stepMs: performance.now() - started,
      portableBytes: world.snapshot().length,
      localCheckpointBytes: world.x.WebNetCaptureLocalCheckpoint(),
    });
  }
  console.log(
    "Focused total simulation cost; includes physics, objects and canonical digests:",
    measurements,
  );
});

test("bot projectile scoring, waiting recovery and respawn retain the same participant", async () => {
  const world = await simulation();
  for (let tick = 0; tick < 3; ++tick) world.step();
  assert.equal(world.x.WebTestPreparePlayerDuel(1, 0, 1200), 1);
  const projectile = world.x.WebTestCreateParticipantProjectile(1);
  assert.ok(projectile);
  assert.equal(world.x.WebTestHitParticipant(projectile, 0), 1);
  world.step();
  assert.deepEqual(world.results(1), [2n, 1, 0]);
  assert.deepEqual(world.results(0), [1n, 0, 1]);
  assert.equal(world.x.WebTestKillParticipant(1), 1);
  world.step();
  assert.deepEqual(world.results(1), [2n, 1, 1]);
  const snapshot = world.snapshot();
  const restored = await simulation();
  restored.restore(snapshot);
  assert.deepEqual(restored.canonical(), world.canonical());
  for (let tick = 0; tick < 40; ++tick) {
    world.step();
    restored.step();
    assert.deepEqual(
      restored.canonical(),
      world.canonical(),
      "waiting/respawn AI replay tick " + tick,
    );
  }
  assert.equal(world.ai(0), 2);
  assert.deepEqual(world.results(1), [2n, 1, 1]);
});

const multipleRoster = { slots: [0, 1, 3, 5, 7], bots: [3, 5, 7] };
function multipleActions(world, tick) {
  const { x } = world;
  const alive = (slot) => !!x.WebTestCarHandle(slot);
  if ([80, 240, 500].includes(tick)) {
    const source = tick < 400 ? 0 : 1;
    if (alive(source))
      for (const slot of multipleRoster.bots)
        if (alive(slot))
          assert.equal(x.WebTestPlacePlayerTarget(source, slot, 900 + slot * 150, 0), 1);
  }
  if (tick === 120 && alive(3)) assert.equal(x.WebTestAiRecovery(3), 1);
  if (tick === 200 && alive(3) && alive(5)) {
    assert.equal(x.WebTestPreparePlayerDuel(3, 5, 1200), 1);
    const projectile = x.WebTestCreateParticipantProjectile(3);
    assert.ok(projectile);
    assert.equal(x.WebTestHitParticipant(projectile, 5), 1);
  }
  if (tick === 300 && alive(0)) assert.equal(x.WebTestKillParticipant(0), 1);
  if (tick === 400) assert.equal(x.WebNetDepartParticipant(x.HeadlessTick(), 0, 1, 0), 1);
  if (tick === 450 && alive(3)) assert.equal(x.WebTestKillParticipant(3), 1);
}

test("two humans and three sparse-slot bots replay combat, departure and portable recovery exactly", async () => {
  const world = await simulation(true, multipleRoster);
  for (let tick = 0; tick < 30; ++tick) world.step();
  const snapshot = world.snapshot(),
    before = world.canonical();
  assert.ok(world.x.WebNetCaptureLocalCheckpoint());
  const expected = [],
    checkpoints = [];
  let humanTargets = 0,
    botTargets = 0,
    routes = 0,
    projectiles = 0;
  for (let tick = 0; tick < 600; ++tick) {
    multipleActions(world, tick);
    world.step();
    expected.push(world.canonical());
    if (tick === 200) {
      assert.deepEqual(world.results(3), [4n, 1, 0]);
      assert.deepEqual(world.results(5), [6n, 0, 1]);
    }
    if ([130, 230, 410, 470].includes(tick))
      checkpoints.push({ tick: tick + 1, snapshot: world.snapshot(), state: world.canonical() });
    for (const slot of multipleRoster.bots) {
      if (!world.x.WebTestCarHandle(slot)) continue;
      assert.equal(world.ai(0, slot), 2);
      assert.equal(world.ai(10, slot), slot % 4);
      const target = world.ai(4, slot);
      humanTargets +=
        target > 0 && [0, 1].some((other) => world.x.WebTestCarHandle(other) === target);
      botTargets +=
        target > 0 &&
        multipleRoster.bots.some(
          (other) => other !== slot && world.x.WebTestCarHandle(other) === target,
        );
      routes += world.ai(2, slot) > 1;
      projectiles += world.ai(24, slot) > 0;
    }
  }
  assert.ok(
    humanTargets && botTargets && routes && projectiles,
    "original AI must route, shoot, and target both control sources",
  );
  assert.equal(world.x.WebNetRestoreLocalCheckpoint(30), 1);
  assert.deepEqual(world.canonical(), before);
  for (let tick = 0; tick < expected.length; ++tick) {
    multipleActions(world, tick);
    world.step();
    assert.deepEqual(world.canonical(), expected[tick], `multiple-bot local tick ${tick}`);
  }
  for (const checkpoint of [{ tick: 0, snapshot, state: before }, ...checkpoints]) {
    const restored = await simulation(true, multipleRoster);
    restored.restore(checkpoint.snapshot);
    assert.deepEqual(restored.canonical(), checkpoint.state);
    for (let tick = checkpoint.tick; tick < expected.length; ++tick) {
      multipleActions(restored, tick);
      restored.step();
      assert.deepEqual(
        restored.canonical(),
        expected[tick],
        `multiple-bot portable ${checkpoint.tick} tick ${tick}`,
      );
    }
  }
  if (process.env.TM4_MULTI_BOT_REFERENCE) {
    fs.mkdirSync(join(process.env.TM4_MULTI_BOT_REFERENCE, ".."), { recursive: true });
    fs.writeFileSync(
      process.env.TM4_MULTI_BOT_REFERENCE,
      JSON.stringify({
        snapshot: snapshot.toString("base64"),
        before: before.toString("base64"),
        rows: expected.map((row) => row.toString("base64")),
      }),
    );
  }
  console.log({ humanTargets, botTargets, routes, projectiles, snapshotBytes: snapshot.length });
});

test("retaliation history uses stable slots when a human leaves and an attacker dies", async () => {
  const world = await simulation(true, multipleRoster);
  for (let tick = 0; tick < 30; ++tick) world.step();
  assert.equal(world.x.WebTestAiAccumulateDamage(7, 5, 17), 1);
  assert.equal(world.x.WebTestAiDamageHistory(7, 5), 17);
  assert.equal(world.x.WebNetDepartParticipant(30, 0, 1, 0), 1);
  assert.equal(world.x.WebTestAiDamageHistory(7, 5), 17);
  const snapshot = world.snapshot();
  const restored = await simulation(true, multipleRoster);
  restored.restore(snapshot);
  assert.equal(restored.x.WebTestAiDamageHistory(7, 5), 17);
  for (const current of [world, restored]) {
    assert.equal(current.x.WebTestKillParticipant(5), 1);
    current.step();
    assert.equal(current.x.WebTestAiDamageHistory(7, 5), 0);
  }
  assert.deepEqual(restored.canonical(), world.canonical());
});

test("normal self damage never provokes AI retaliation but other humans and bots do", async () => {
  const world = await simulation(true, { slots: [0, 1, 2], bots: [1, 2] });
  for (let tick = 0; tick < 30; ++tick) world.step();
  const identity = world.results(1);
  for (const damage of [0, 1]) {
    // Zero asks the fixture for threshold + 1; also repeat with one point of self damage.
    const applied = world.x.WebTestAiApplyRetaliationDamage(1, 1, damage);
    assert.ok(applied > 0, "eligible bot survives actual self damage");
    assert.ok(world.ai(8, 1) > 0);
    assert.equal(world.ai(4, 1), 0, "self damage must not select self as the AI target");
    assert.equal(
      world.x.WebTestAiDamageHistory(1, 1),
      0,
      "self damage must not accumulate retaliation history",
    );
    assert.deepEqual(world.results(1), identity, "nonlethal self damage preserves combat results");
  }
  for (const attacker of [0, 2]) {
    const applied = world.x.WebTestAiApplyRetaliationDamage(1, attacker, 0);
    assert.ok(
      applied > 0,
      `participant ${attacker} applies nonlethal damage above the threshold (applied ${applied})`,
    );
    assert.equal(
      world.ai(4, 1),
      world.x.WebTestCarHandle(attacker),
      "another participant still provokes retaliation",
    );
    assert.ok(world.ai(2, 1) > 0, "retaliation acquires an original navigation route");
    assert.deepEqual(world.results(1), identity);
  }
});

test("eight occupied slots with two humans and six original bots retain portable determinism", async () => {
  const configuration = {
    slots: [0, 1, 2, 3, 4, 5, 6, 7],
    bots: [2, 3, 4, 5, 6, 7],
    pool: [
      "Orbital",
      "Pizza Boy",
      "Capt. Grimm",
      "Calypso",
      "Quatro",
      "Goggle Eyes",
      "Meter Maid",
      "Gen. Warthog",
    ],
  };
  const world = await simulation(true, configuration);
  for (let tick = 0; tick < 30; ++tick) world.step();
  const snapshot = world.snapshot();
  const expected = [];
  let botTargets = 0;
  const models = new Set();
  for (let tick = 0; tick < 360; ++tick) {
    if ([180, 240, 300].includes(tick))
      for (const slot of [2, 4, 6])
        if (world.x.WebTestCarHandle(slot)) assert.equal(world.x.WebTestKillParticipant(slot), 1);
    world.step();
    expected.push(world.canonical());
    for (const slot of configuration.bots) {
      if (world.x.WebTestCarHandle(slot)) {
        assert.equal(world.ai(0, slot), 2);
        assert.equal(world.ai(10, slot), slot % 4);
        models.add(world.x.WebTestRespawnState(slot, 4));
      }
      const target = world.ai(4, slot);
      botTargets +=
        target > 0 &&
        configuration.bots.some(
          (other) => other !== slot && world.x.WebTestCarHandle(other) === target,
        );
    }
  }
  assert.ok(botTargets, "bots must acquire other bots in the full roster");
  assert.ok(models.size > 2, "random respawn uses the prepared model pool");
  for (const slot of [2, 4, 6]) assert.ok(world.results(slot)[2] >= 3);
  console.log({ eightSeatRespawnModels: [...models], snapshotBytes: snapshot.length });
  const restored = await simulation(true, configuration);
  restored.restore(snapshot);
  for (let tick = 0; tick < expected.length; ++tick) {
    if ([180, 240, 300].includes(tick))
      for (const slot of [2, 4, 6])
        if (restored.x.WebTestCarHandle(slot))
          assert.equal(restored.x.WebTestKillParticipant(slot), 1);
    restored.step();
    assert.deepEqual(restored.canonical(), expected[tick], `eight-seat tick ${tick}`);
  }
});

test("late human admission alongside AI replays across rollback and portable recovery", async () => {
  const config = { slots: [0, 1, 2], bots: [1, 2], cars: ["Orbital", "Pizza Boy", "Orbital"] };
  const world = await simulation(true, config);
  assert.equal(world.ai(0, 1), 2);
  assert.equal(world.ai(0, 2), 2);
  for (let i = 0; i < 30; ++i) world.step();
  const actions = (world) => {
    const x = world.x;
    const tick = x.HeadlessTick();
    if (tick === 32 || tick === 40 || tick === 48) {
      const model = new TextEncoder().encode("Pizza Boy\0");
      const address = x.malloc(model.length);
      new Uint8Array(x.memory.buffer).set(model, address);
      try {
        assert.equal(
          x.WebNetAdmitParticipant(
            tick,
            tick === 48 ? 0 : 3,
            tick === 32 ? 9 : tick === 40 ? 10 : 11,
            0,
            address,
          ),
          1,
        );
      } finally {
        x.free(address);
      }
    }
    if (tick === 37) assert.equal(x.WebNetDepartParticipant(tick, 3, 9, 0), 1);
    if (tick === 45) assert.equal(x.WebNetDepartParticipant(tick, 0, 1, 0), 1);
  };
  assert.ok(world.x.WebNetCaptureLocalCheckpoint());
  const expected = [];
  const snapshots = [];
  for (let tick = 30; tick < 60; ++tick) {
    actions(world);
    world.step();
    expected.push(world.canonical());
    if ([31, 34, 38, 43, 46, 50].includes(tick)) snapshots.push([tick + 1, world.snapshot()]);
  }
  assert.equal(world.x.WebNetRestoreLocalCheckpoint(30), 1);
  for (let tick = 30; tick < 60; ++tick) {
    actions(world);
    world.step();
    assert.deepEqual(world.canonical(), expected[tick - 30], "local replay " + tick);
  }
  for (const [start, snapshot] of snapshots) {
    const restored = await simulation(true, config);
    restored.restore(snapshot);
    for (let tick = start; tick < 60; ++tick) {
      actions(restored);
      restored.step();
      assert.deepEqual(restored.canonical(), expected[tick - 30], "portable replay " + tick);
    }
  }
});
