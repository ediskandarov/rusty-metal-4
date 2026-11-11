const { chromium } = require("playwright");
const { writeFileSync } = require("node:fs");
const { fixtureAction, fixtureCommands } = require("./fixture.cjs");
(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--enable-unsafe-swiftshader", "--mute-audio"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error(error));
    await page.goto(
      new URL("?authority=1&checkpoint=1", process.env.TM4_WEB_URL || "http://127.0.0.1:18327")
        .href,
    );
    await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 60000 });
    const record = await page.evaluate(
      ({ action, commands }) => {
        const { Module, tm4Port } = globalThis;
        const fixtureAction = eval(`(${action})`);
        const fixtureCommands = eval(`(${commands})`);
        const assert = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const rows = [];
        const read = () => {
          assert(Module._WebNetCaptureState(), "canonical capture");
          const bytes = tm4Port.netCapturedState;
          let text = "";
          for (const byte of bytes) text += String.fromCharCode(byte);
          const { tick, digest, sections, unsupported } = tm4Port.netMatch;
          assert(!unsupported, unsupported);
          return { tick, digest, sections, canonical: btoa(text) };
        };
        const started = performance.now();
        assert(Module._WebNetRequestMatch(2, 0, 12345, -1), "start");
        const startupMs = performance.now() - started;
        rows.push(read());
        const stepMs = [];
        const events = [];
        const tape = [];
        for (let tick = 0; tick < 300; tick++) {
          const action = fixtureAction(tick);
          if (action) assert(Module[action[0]](action[1]), `action ${tick}`);
          const inputs = fixtureCommands(tick);
          tape.push({ action, inputs });
          const start = performance.now();
          inputs.forEach((input, slot) =>
            assert(Module._WebNetSetInput(tick, slot, input.buttons, 0, 0), "input"),
          );
          assert(Module._WebNetQueueTick(tick), "step");
          stepMs.push(performance.now() - start);
          rows.push(read());
          Module._WebTestLocalCheckpointProjectiles();
          events.push({
            live: tm4Port.testLiveProjectiles,
            spawned: tm4Port.projectileSpawns || 0,
            removed: tm4Port.projectileRemoved || 0,
            impacts: tm4Port.projectileImpacts || 0,
          });
        }
        const result = {
          rows,
          events,
          tape,
          startupMs,
          stepMs,
          cars: tm4Port.cars.map((car) => car.name),
          health: tm4Port.cars.map((car) => car.health),
          frames: tm4Port.levelFrames,
          memoryBytes: null,
        };
        Module._WebNetCancelMatch();
        return result;
      },
      { action: fixtureAction.toString(), commands: fixtureCommands.toString() },
    );
    writeFileSync(process.argv[2] || "build/browser-record.json", JSON.stringify(record));
    console.log(
      JSON.stringify({
        rows: record.rows.length,
        cars: record.cars,
        startupMs: record.startupMs,
        final: record.rows.at(-1).digest,
        events: record.events.at(-1),
        health: record.health,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
