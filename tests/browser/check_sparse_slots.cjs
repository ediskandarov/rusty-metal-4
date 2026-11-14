/* global tm4Port, Module */
const assert = require("node:assert/strict");
const { launchBrowser } = require("./helpers/browser.cjs");
const { readyInLobby } = require("./network_lobby.cjs");
const endpoint = process.env.TM4_MATCH_ENDPOINT;
const room = process.env.TM4_SPARSE_ROOM === "1";
const slots = room ? [3, 6] : [0, 3, 7];
const localSlot = slots.at(-1);
const expectedRoots = Array.from({ length: 8 }, (_, slot) => (slots.includes(slot) ? 15 : 0));
assert(endpoint, "Start the ignored sparse_match_browser_fixture Rust test first");
const target = new URL(process.env.TM4_WEB_URL ?? "http://127.0.0.1:18337/");
target.searchParams.set("match", endpoint);
(async () => {
  const browser = await launchBrowser();
  const pages = [];
  const errors = [];
  try {
    for (let index = 0; index < slots.length; index++) {
      const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
      if (room)
        await page.addInitScript(
          ([key, token]) => {
            if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, token);
          },
          ["tm4.resume." + endpoint, ["aa", "bb"][index].repeat(32)],
        );
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") console.log("CLIENT", index, message.text());
      });
      pages.push(page);
      await page.goto(target.href);
      if (room) {
        await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
          timeout: 60000,
        });
        continue;
      }
      await page.locator("#car-lobby").waitFor({ state: "visible", timeout: 60000 });
      assert.equal(
        await page.locator("#car-lobby-player").innerText(),
        `Player ${slots[index] + 1}`,
      );
    }
    if (!room) await Promise.all(pages.map(readyInLobby));
    await Promise.all(
      pages.map((page) =>
        page.waitForFunction(() => globalThis.tm4Port?.netConfirmedTick >= 90, null, {
          timeout: 60000,
        }),
      ),
    );
    const bindings = await Promise.all(
      pages.map((page) =>
        page.evaluate(() => ({
          slot: tm4Port.netViewSlot,
          attached: tm4Port.netCameraAttached,
          roots: Array.from({ length: 8 }, (_, slot) => Module._WebTestNetworkSlotBindings(slot)),
          cars: tm4Port.cars.map((car) => car.player).sort((a, b) => a - b),
          remaining: tm4Port.netMatch.remaining,
          capacity: tm4Port.netMatch.capacity,
          scoreCount: tm4Port.netMatch.scores.length,
          tick: tm4Port.netConfirmedTick,
        })),
      ),
    );
    assert.deepEqual(
      bindings.map((row) => row.slot),
      slots,
    );
    for (const row of bindings) {
      assert(row.attached);
      assert.equal(row.remaining, slots.length);
      assert.equal(row.capacity, 8);
      assert.equal(row.scoreCount, 8);
      assert.deepEqual(row.cars, slots);
      assert.deepEqual(row.roots, expectedRoots);
    }
    const local = pages.at(-1);
    await local.evaluate((remoteSlot) => {
      globalThis.tm4SparseHud = 0;
      const confirm = Module._WebNetConfirmPresentationTick;
      Module._WebNetConfirmPresentationTick = (tick) => {
        const count = confirm(tick);
        globalThis.tm4SparseHud += count;
        return count;
      };
      Module._WebTestNetworkHudMessages(remoteSlot, 1);
    }, slots[0]);
    await local.waitForTimeout(700);
    assert.equal(
      await local.evaluate(() => globalThis.tm4SparseHud),
      0,
      "Remote slot leaked into the local HUD",
    );
    await local.evaluate((slot) => Module._WebTestNetworkHudMessages(slot, 1), localSlot);
    await local.waitForFunction(() => globalThis.tm4SparseHud === 1);
    await local.screenshot({ path: `build/r338-rework-slot${localSlot}.png` });
    const origin = await local.evaluate((slot) => {
      const car = tm4Port.cars.find((car) => car.player === slot);
      return [car.x, car.z];
    }, localSlot);
    await local.locator("canvas").focus();
    await local.keyboard.down("x");
    await local.waitForFunction(
      (slot) => tm4Port.cars.find((car) => car.player === slot)?.throttle !== 0,
      localSlot,
      { timeout: 10000 },
    );
    await local.waitForTimeout(900);
    await local.keyboard.up("x");
    const driven = await local.evaluate(() =>
      tm4Port.cars.map((car) => ({ slot: car.player, throttle: car.throttle, x: car.x, z: car.z })),
    );
    const car = driven.find((car) => car.slot === localSlot);
    assert(Math.hypot(car.x - origin[0], car.z - origin[1]) > 5, "Local sparse slot did not move");
    assert(
      driven.filter((car) => car.slot !== localSlot).every((car) => car.throttle === 0),
      "Input affected another slot",
    );
    const before = await pages[0].evaluate(() => tm4Port.netConfirmedTick);
    await local.reload();
    await local.waitForFunction(
      () =>
        globalThis.tm4Port?.netDiagnostics?.recoveredTick > 0 &&
        tm4Port.netConfirmedTick > tm4Port.netDiagnostics.recoveredTick + 90,
      null,
      { timeout: 60000 },
    );
    const recovered = await local.evaluate(() => ({
      slot: tm4Port.netViewSlot,
      capacity: tm4Port.netMatch.capacity,
      scoreCount: tm4Port.netMatch.scores.length,
      roots: Array.from({ length: 8 }, (_, slot) => Module._WebTestNetworkSlotBindings(slot)),
      tick: tm4Port.netConfirmedTick,
      diagnostics: tm4Port.netDiagnostics,
    }));
    assert.equal(recovered.slot, localSlot);
    assert.equal(recovered.capacity, 8);
    assert.equal(recovered.scoreCount, 8);
    assert.deepEqual(recovered.roots, expectedRoots);
    assert(await pages[0].evaluate((tick) => tm4Port.netConfirmedTick > tick + 90, before));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ bindings, driven, recovered }, null, 2));
    console.log(
      `PASS ${room ? "authenticated room" : "open lobby"} slots ${slots}: capacity 8, native controls/camera/HUD, no phantom cars, portable reconnect and survivor continuation`,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
