const { readFileSync, readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

// One C world per process. A host must never share tm4Port between instances.
async function createMatch({ modulePath, resources, world = 0, cars = [], seed = 12345 }) {
  if (globalThis.tm4Port) throw new Error("Only one headless world is supported per process");
  const started = performance.now();
  const createModule = require(resolve(modulePath));
  const engine = await createModule({
    noInitialRun: true,
    print: console.error,
    printErr: console.error,
  });
  const load = (directory, destination) => {
    engine.FS.mkdirTree(destination);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) load(path, `${destination}/${entry.name}`);
      else engine.FS.writeFile(`${destination}/${entry.name}`, readFileSync(path));
    }
  };
  load(join(resolve(resources), "DATA"), "/DATA");
  engine.tm4LocalCheckpoint = true;
  engine.callMain(["--session", "--authority"]);
  const tm4Port = globalThis.tm4Port;
  if (!tm4Port.platformReady) throw new Error("Headless platform startup failed");
  for (const [slot, car] of cars.entries())
    if (!engine.ccall("WebNetSelectCar", "number", ["number", "string"], [slot, car]))
      throw new Error(`Unknown car ${car}`);
  const index =
    typeof world === "string"
      ? engine.ccall("WebNetWorldIndex", "number", ["string"], [world])
      : world;
  if (!engine._WebNetRequestMatch(cars.length || 2, index, seed, -1))
    throw new Error(`Match creation failed: ${JSON.stringify(tm4Port.netSession)}`);
  const read = () => {
    if (!engine._WebNetCaptureState()) throw new Error("Canonical capture refused");
    return { ...tm4Port.netMatch, bytes: Buffer.from(tm4Port.netCapturedState) };
  };
  return {
    engine,
    startupMs: performance.now() - started,
    read,
    step(commands) {
      const tick = tm4Port.netMatch.tick;
      if (commands.length !== tm4Port.netMatch.players) throw new Error("Wrong command count");
      commands.forEach(({ buttons = 0, axes = 0, analog = false }, slot) => {
        if (!engine._WebNetSetInput(tick, slot, buttons, axes, +analog))
          throw new Error("Input refused");
      });
      if (!engine._WebNetQueueTick(tick)) throw new Error("Tick refused");
      return read();
    },
    save() {
      const bytes = engine._WebNetCaptureLocalCheckpoint();
      if (!bytes) throw new Error(`Save refused: ${tm4Port.localCheckpointError}`);
      return bytes;
    },
    restore() {
      if (!engine._WebNetRestoreLocalCheckpoint())
        throw new Error(`Restore refused: ${tm4Port.localCheckpointError}`);
      return read();
    },
    finishReplay() {
      if (!engine._WebNetFinishLocalReplay()) throw new Error("Replay finish refused");
    },
    destroy() {
      engine._WebNetCancelMatch();
      delete globalThis.tm4Port;
    },
  };
}
module.exports = { createMatch };
if (require.main === module) {
  const [modulePath, resources] = process.argv.slice(2);
  createMatch({ modulePath, resources })
    .then((match) => {
      console.log(
        JSON.stringify({
          startupMs: match.startupMs,
          state: { ...match.read(), bytes: match.read().bytes.length },
        }),
      );
      for (let tick = 0; tick < 90; tick++) match.step([{ buttons: 0x40 }, { buttons: 0x40 }]);
      console.log(JSON.stringify({ state: { ...match.read(), bytes: match.read().bytes.length } }));
      match.destroy();
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
