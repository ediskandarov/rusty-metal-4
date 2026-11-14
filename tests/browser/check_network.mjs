/* global Module, tm4Port */
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { leaveMatch, readyInLobby } from "./network_lobby.mjs";
import { fixtureTape, observeAcceptedFrames } from "./simulation_reference.mjs";

const endpoint = process.env.TM4_MATCH_ENDPOINT;
const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:8120/";
if (!endpoint) throw new Error("Set TM4_MATCH_ENDPOINT");
const browser = await launchBrowser({
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--mute-audio",
  ],
});
let observation;
try {
  const [reference, ...clients] = await Promise.all(
    Array.from({ length: 3 }, () => browser.newPage()),
  );
  const pages = [reference, ...clients];
  const fixture = await fixtureTape();
  await fixture(60, "contact");
  await fixture(110, "duel", 2500);
  await fixture(110, "projectile", undefined, { args: [0, 1], projectile: "bullet", until: 170 });
  observation = await observeAcceptedFrames(reference, clients);
  await Promise.all(
    pages.map(async (page, index) => {
      page.on("pageerror", (e) => console.error("PAGE", index, e));
      page.on("console", (m) => {
        if (/initialized:|Match cars|FIXTURE/.test(m.text())) console.log("PAGE", index, m.text());
      });
      await page.goto(
        index ? site + "?match=" + encodeURIComponent(endpoint) : site + "?simulation-reference=1",
      );
      await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
        timeout: 60000,
      });
      await page.evaluate(() => {
        const queue = Module._WebNetQueueTick;
        Module._WebNetQueueTick = (tick) => {
          if (tick === 60 && Module._WebTestPlaceWeaponTarget(128) <= 0)
            throw new Error("Could not place the cars for contact");
          if (tick === 110) {
            if (!Module._WebTestPrepareNetworkDuel(2500))
              throw new Error("Could not place the target");
            console.log("FIXTURE", tick);
          }
          if (tick >= 110 && tick < 170)
            Module.ccall(
              "WebTestPlacePlayerProjectileTarget",
              "number",
              ["number", "number", "string"],
              [0, 1, "bullet"],
            );
          const result = queue(tick);
          globalThis.networkTestRows ??= {};
          globalThis.networkTestRows[tick + 1] = {
            car: Module._WebTestCarHandle(1),
            model: tm4Port.cars.find((car) => car.player === 1)?.name,
            state: Module._WebTestRespawnState(1, 0),
            due: Module._WebTestRespawnState(1, 1),
          };
          return result;
        };
      });
    }),
  );
  await Promise.all(clients.map(readyInLobby));
  await Promise.all(clients.map((page) => page.waitForFunction(() => tm4Port.netCameraAttached)));
  const slots = await Promise.all(clients.map((page) => page.evaluate(() => tm4Port.netViewSlot)));
  assert.deepEqual([...slots].sort(), [0, 1]);
  const shooter = clients[slots.indexOf(0)];
  await shooter.bringToFront();
  await shooter.locator("canvas").click();
  await shooter.keyboard.down("x");
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(() => Module._WebTestNetworkCarContact(), null, { timeout: 8000 }),
    ),
  );
  await shooter.keyboard.up("x");
  await shooter.waitForFunction(() => tm4Port.netMatch.tick >= 111);
  await shooter.locator("canvas").focus();
  await shooter.keyboard.down("e");
  await shooter.waitForFunction(() => tm4Port.bulletSpawns > 0, null, { timeout: 3000 });
  await Promise.all(
    clients.map((page) =>
      page.waitForFunction(() => tm4Port.netMatchServerState?.scores[1]?.deaths === 1, null, {
        timeout: 13000,
      }),
    ),
  );
  await shooter.keyboard.up("e");
  const waiting = await shooter.evaluate(() => ({
    before: globalThis.networkTestRows[110].car,
    model: globalThis.networkTestRows[110].model,
    rows: Object.values(globalThis.networkTestRows),
    state: tm4Port.netMatchServerState,
  }));
  const death = waiting.rows.find((row) => row.state === 2);
  assert(death && death.car === 0 && death.due > 110, JSON.stringify(waiting));
  for (const client of clients)
    await client.waitForFunction(
      (due) => tm4Port.netConfirmedTick > due + 10 && Module._WebTestCarHandle(1) > 0,
      death.due,
      { timeout: 15000 },
    );
  for (const client of clients) {
    const result = await client.evaluate(() => ({
      state: tm4Port.netMatchServerState,
      local: tm4Port.netMatch,
      confirmed: tm4Port.netConfirmedTick,
      car: Module._WebTestCarHandle(1),
      model: tm4Port.cars.find((car) => car.player === 1)?.name,
      health: tm4Port.cars.find((car) => car.player === 1)?.health,
      status: document.querySelector("#status").textContent,
    }));
    assert.equal(result.state.roundFinished, false);
    assert.equal(result.state.acceptsContinue, false);
    assert.equal(result.state.nextMode, 0);
    assert.equal(result.state.remaining, 2);
    assert.deepEqual(result.state.scores, [
      { frags: 1, deaths: 0 },
      { frags: 0, deaths: 1 },
      ...Array.from({ length: 6 }, () => ({ frags: 0, deaths: 0 })),
    ]);
    assert(result.car > waiting.before, "respawn creates a new car serial");
    assert.equal(result.model, waiting.model);
    assert(result.health > 1, "respawn does not inherit the one-health target state");
    assert(result.confirmed > death.due && result.local.tick >= result.confirmed);
    assert(!/diverged|unsupported/i.test(result.status));
  }
  const departed = clients[slots.indexOf(1)];
  await leaveMatch(departed);
  await shooter.waitForFunction(
    () => Module._WebNetSlotMask() === 1 && tm4Port.netMatchServerState?.remaining === 1,
    null,
    { timeout: 15000 },
  );
  assert.equal(await shooter.evaluate(() => tm4Port.netMatchServerState.roundFinished), false);
  await leaveMatch(shooter);
  for (const client of clients)
    await client.waitForFunction(() => !tm4Port.netMatch, null, { timeout: 15000 });
  await observation.settled();
  await reference.evaluate(() => Module._WebNetCancelMatch());
  // Explicit teardown releases all rollback storage and permits fresh FFA sessions in the same C instance.
  for (const page of pages) {
    assert.equal(await page.evaluate(() => Module._WebNetLocalCheckpointStorageBytes()), 0);
    for (const seed of [54321, 54322])
      assert.equal(
        await page.evaluate((seed) => {
          const started = Module.ccall(
            "WebNetStartFfa",
            "number",
            [
              "number",
              "number",
              "number",
              "number",
              "number",
              "number",
              "string",
              "string",
              "number",
              "string",
            ],
            [
              8,
              3,
              0,
              seed,
              -1,
              0,
              "Orbital\nPizza Boy",
              "0000000000000011\n0000000000000012",
              90,
              "Orbital\nPizza Boy",
            ],
          );
          if (
            !started ||
            tm4Port.netMatch.tick !== 0 ||
            tm4Port.netMatch.scores.some((score) => score.frags || score.deaths)
          )
            return false;
          for (let tick = 0; tick < 3; ++tick) {
            for (let slot = 0; slot < 2; ++slot)
              if (!Module._WebNetSetInput(tick, slot, 0, 0, 0)) return false;
            if (!Module._WebNetQueueTick(tick)) return false;
          }
          const ready = tm4Port.netMatch.tick === 3 && tm4Port.netMatch.unsupported === null;
          Module._WebNetCancelMatch();
          return ready && Module._WebNetLocalCheckpointStorageBytes() === 0;
        }, seed),
        true,
      );
  }
  console.log(
    "PASS contact, real weapon kill, same-model FFA respawn, preserved combat scores, explicit departure/teardown and two fresh C sessions",
  );
} catch (error) {
  console.error("REFERENCE", observation?.error);
  for (const page of browser.contexts().flatMap((context) => context.pages())) {
    console.error(
      await page
        .evaluate(() => ({
          state: tm4Port.netMatch,
          server: tm4Port.netMatchServerState,
          cars: tm4Port.cars,
          bullets: tm4Port.bulletSpawns,
          status: document.querySelector("#status").textContent,
        }))
        .catch(() => undefined),
    );
  }
  throw error;
} finally {
  await browser.close();
}
