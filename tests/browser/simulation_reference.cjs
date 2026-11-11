/* Independent browser C oracle fed accepted client Frame records. Never a server host. */
const assert = require("node:assert/strict");
const { writeFile, rename } = require("node:fs/promises");
const { resolve } = require("node:path");

async function fixtureTape(configuration = {}) {
  const path = process.env.TM4_TEST_ACTIONS;
  assert(
    path,
    "Start a diagnostic Rust server with TM4_TEST_ACTIONS set to the local action-tape path",
  );
  const data = { ...configuration, actions: [] };
  const write = async () => {
    await writeFile(resolve(path) + ".pending", JSON.stringify(data));
    await rename(resolve(path) + ".pending", resolve(path));
  };
  await write();
  return async (tick, name, distance, details = {}) => {
    data.actions.push({ tick, name, distance, ...details });
    await write();
  };
}

async function observeAcceptedFrames(reference, clients) {
  let tail = Promise.resolve();
  let error;
  const pending = new Map();
  let started = false;
  let head = 0;
  const receive = (messages) => {
    tail = tail
      .then(async () => {
        for (const message of messages) {
          if (message.type === "prediction_prepare" && !started) {
            await reference.evaluate((start) => {
              const { Module } = globalThis;
              if (start.portable && !Module._WebNetEnablePortableCheckpoint())
                throw new Error("Reference portable setup rejected");
              for (const [slot, name] of start.cars.entries())
                if (!Module.ccall("WebNetSelectCar", "number", ["number", "string"], [slot, name]))
                  throw new Error("Reference car rejected");
              const world = Module.ccall("WebNetWorldIndex", "number", ["string"], [start.world]);
              if (!Module._WebNetRequestMatch(start.players, world, start.seed, -1))
                throw new Error("Reference match rejected");
            }, message);
            started = true;
          }
          if (message.type === "frame" && message.tick >= head) pending.set(message.tick, message);
        }
        while (started && pending.has(head)) {
          const frame = pending.get(head);
          pending.delete(head);
          await reference.evaluate(({ tick, inputs, state }) => {
            const { Module, tm4Port } = globalThis;
            inputs.forEach((input, slot) => {
              if (!Module._WebNetSetInput(tick, slot, input.buttons, input.axes, +input.analog))
                throw new Error("Reference input rejected");
            });
            if (!Module._WebNetQueueTick(tick)) throw new Error("Reference tick rejected");
            const actual = tm4Port.netMatch;
            if (
              actual.digest !== state.digest ||
              actual.sections.some((value, i) => value !== state.sections[i])
            )
              throw new Error("Rust/browser reference diverged at " + tick);
            if (state.nextMode) Module._WebNetCancelMatch();
          }, frame);
          head++;
        }
      })
      .catch((caught) => {
        error ??= caught;
      });
  };
  for (const page of clients) {
    await page.exposeFunction("tm4ObserveAccepted", receive);
    await page.route("**/network/tm4_network.js", async (route) => {
      const response = await route.fetch();
      const hook = `\nconst referenceUpdate = NetworkClient.prototype.update;
NetworkClient.prototype.update = function() {
  const raw = referenceUpdate.call(this);
  const records = JSON.parse(raw).filter(({type}) => type === "prediction_prepare" || type === "frame");
  if (records.length) void globalThis.tm4ObserveAccepted(records);
  return raw;
};\n`;
      await route.fulfill({ response, body: (await response.text()) + hook });
    });
  }
  return {
    get error() {
      return error;
    },
    async settled() {
      await tail;
      if (error) throw error;
    },
  };
}
module.exports = { fixtureTape, observeAcceptedFrames };
