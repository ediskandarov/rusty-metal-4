/* Replay a captured authority journal through the actual simulation Wasm. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { WASI } from "node:wasi";
try {
  const bytes = fs.readFileSync(process.argv[2]);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "544d344a524e4c03");
  const headerLength = bytes.readUInt32LE(8),
    header = JSON.parse(bytes.subarray(12, 12 + headerLength).toString()),
    start = header.start;
  const wasi = new WASI({
    version: "preview1",
    preopens: { "/DATA": join(process.env.TM4_RESOURCE_DIR, "DATA") },
    returnOnExit: true,
  });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(fs.readFileSync(process.env.TM4_SIMULATION_WASM)),
    { wasi_snapshot_preview1: wasi.wasiImport },
  );
  wasi.initialize(instance);
  const x = instance.exports,
    memory = () => new Uint8Array(x.memory.buffer);
  const arg = (text, run) => {
    const value = new TextEncoder().encode(text + "\0"),
      address = x.malloc(value.length);
    memory().set(value, address);
    try {
      return run(address);
    } finally {
      x.free(address);
    }
  };
  assert.equal(x.HeadlessInitialize(), 1);
  const world = arg(start.world, (address) => x.WebNetWorldIndex(address));
  arg(start.cars.join("\n"), (cars) =>
    arg(start.participants.join("\n"), (ids) =>
      assert.equal(
        x.WebNetStartFfa(
          start.capacity,
          start.slots.reduce((mask, slot) => mask | (1 << slot), 0),
          world,
          start.seed,
          -1,
          1,
          cars,
          ids,
          start.respawnDelayTicks,
        ),
        1,
      ),
    ),
  );
  const fixture = process.env.TM4_TEST_ACTIONS
    ? JSON.parse(fs.readFileSync(process.env.TM4_TEST_ACTIONS, "utf8"))
    : { actions: [] };
  let offset = 16 + headerLength,
    tick = 0,
    events = 0;
  const width = 118 + 7 * start.capacity;
  while (offset < bytes.length && bytes[offset] === 1) {
    assert(offset + width + 5 <= bytes.length, "Truncated published frame");
    const row = offset + 1,
      count = bytes[row + 29];
    assert(count <= 8);
    for (let i = 0; i < count; i++) {
      const entry = row + 30 + i * 11,
        kind = bytes[entry],
        slot = bytes[entry + 1],
        id = bytes.readBigUInt64LE(entry + 2),
        low = Number(id & 0xffffffffn),
        high = Number(id >> 32n);
      if (kind === 1)
        assert.equal(
          arg(start.cars[bytes[entry + 10]], (model) =>
            x.WebNetAdmitParticipant(tick, slot, low, high, model),
          ),
          1,
          `Admission ${tick}`,
        );
      else {
        assert.equal(kind, 2);
        assert.equal(x.WebNetDepartParticipant(tick, slot, low, high), 1, `Departure ${tick}`);
      }
      events++;
    }
    const mask = x.WebNetSlotMask();
    for (let slot = 0; slot < start.capacity; slot++)
      if (mask & (1 << slot)) {
        const input = row + 118 + slot * 7;
        assert.equal(
          x.WebNetSetInput(
            tick,
            slot,
            bytes.readUInt16LE(input),
            bytes.readUInt32LE(input + 2),
            bytes[input + 6],
          ),
          1,
        );
      }
    for (const action of fixture.actions ?? [])
      if (action.tick === tick) {
        assert.equal(action.name, "kill", "Unsupported diagnostic replay action");
        assert.equal(x.WebTestKillParticipant(...action.args), 1);
      }
    assert.equal(x.WebNetQueueTick(tick), 1);
    const state = x.HeadlessState(),
      view = new DataView(x.memory.buffer);
    assert.equal(view.getUint32(state + 28, true), bytes.readUInt32LE(row), `Digest ${tick + 1}`);
    for (let part = 0; part < 5; part++)
      assert.equal(
        view.getUint32(state + 32 + part * 4, true),
        bytes.readUInt32LE(row + 4 + part * 4),
        `Section ${part} at ${tick + 1}`,
      );
    tick++;
    offset += width + 5;
  }
  assert(
    events >= Number(process.env.TM4_MIN_MEMBERSHIP_EVENTS ?? 3),
    "Capture must include admission, departure and slot reuse",
  );
  console.log(
    `PASS captured live membership journal: ${tick} actual-Wasm ticks, ${events} membership decisions, all complete subsystem digests matched`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
