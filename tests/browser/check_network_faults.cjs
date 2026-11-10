/* global Module, tm4Port, tm4Network, peer */
/* Protocol faults cross the real Rust/Wasm native input channel and the C adapter.
 * Summary equality here is deliberately not a claim of complete C-state equality. */
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

(async () => {
  const { connectAuthority } = await import("../../tools/network/authority.ts");
  const endpoint = process.env.TM4_MATCH_ENDPOINT;
  const token = process.env.TM4_AUTHORITY_TOKEN;
  const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:18180/";
  const count = Number(process.env.TM4_TEST_PLAYERS ?? 2);
  if (!endpoint || !token) throw new Error("Set TM4_MATCH_ENDPOINT and TM4_AUTHORITY_TOKEN");
  const browser = await chromium.launch({
    channel: "chrome",
    args: [
      "--enable-unsafe-swiftshader",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  let authorityError;
  try {
    const pages = await Promise.all(Array.from({ length: count + 1 }, () => browser.newPage()));
    const [authority, ...clients] = pages;
    await Promise.all(
      pages.map(async (page, index) => {
        await page.addInitScript(() => {
          window.requestAnimationFrame = () => 0;
        });
        await page.goto(new URL(index ? "?session=1" : "?authority=1", site).href);
        await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, {
          timeout: 60000,
          polling: 100,
        });
      }),
    );
    void connectAuthority(authority, endpoint, token).catch((error) => {
      authorityError = error;
    });
    if (process.env.TM4_TEST_MISMATCH) {
      await clients[0].evaluate(() => {
        tm4Port.compatibility.content = "0".repeat(64);
      });
    }
    for (const client of clients) {
      await client.evaluate(async (endpoint) => {
        const socket = await tm4Network.connect(endpoint);
        globalThis.peer = {
          socket,
          slot: -1,
          tick: 0,
          epoch: 0,
          frames: [],
          rejected: [],
          errors: [],
        };
        socket.onopen = () => socket.send({ type: "join", compatibility: tm4Port.compatibility });
        socket.onerror = (error) => peer.errors.push(String(error));
        socket.onmessage = (message) => {
          try {
            switch (message.type) {
              case "welcome":
                peer.slot = message.slot;
                break;
              case "start":
                if (!tm4Network.configure(Module, message, peer.slot))
                  throw new Error("C startup refused");
                peer.epoch = message.epoch;
                socket.send({
                  type: "ready",
                  epoch: message.epoch,
                  digest: tm4Port.netMatch.digest,
                });
                break;
              case "frame":
                if (message.tick !== peer.tick) throw new Error("Nonsequential frame");
                for (const [slot, input] of message.inputs.entries()) {
                  if (
                    !Module._WebNetSetInput(
                      message.tick,
                      slot,
                      input.buttons,
                      input.axes,
                      +input.analog,
                    )
                  )
                    throw new Error("C input refused");
                }
                if (!Module._WebNetQueueTick(message.tick)) throw new Error("C step refused");
                if (tm4Port.netMatch.digest !== message.state.digest)
                  throw new Error("Summary divergence at " + message.tick);
                peer.tick++;
                peer.frames.push(message);
                if (peer.frames.length > 240) peer.frames.shift();
                if (message.tick % 15 === 0) socket.send({ type: "progress", tick: message.tick });
                break;
              case "input_rejected":
                peer.rejected.push(message);
                break;
              case "error":
                throw new Error(message.message);
            }
          } catch (error) {
            peer.errors.push(String(error));
          }
        };
      }, endpoint);
    }
    if (process.env.TM4_TEST_MISMATCH) {
      for (const client of clients) {
        await client.waitForFunction(() => peer.errors.length > 0, null, { polling: 50 });
        const state = await client.evaluate(() => ({
          errors: peer.errors,
          started: !!tm4Port.netMatch,
        }));
        assert.match(state.errors[0], /resources do not match/);
        assert.equal(state.started, false, "Incompatible client initialized gameplay");
      }
      console.log("PASS: incompatible local gameplay content rejected before C initialization");
      return;
    }
    const waitTick = (page, tick) =>
      page.waitForFunction((tick) => peer.tick >= tick || peer.errors.length, tick, {
        timeout: 20000,
        polling: 50,
      });
    await Promise.all(clients.map((client) => waitTick(client, 30)));
    const target = clients[count - 1];
    const slot = await target.evaluate(() => peer.slot);
    await target.evaluate(() => peer.socket.condition(100, 30));
    const intended = await target.evaluate(() => {
      const tick = peer.tick + 18;
      for (const [sequence, buttons] of [
        [1, 0x40],
        [2, 0],
        [1, 0x40],
      ]) {
        peer.socket.send({
          type: "input",
          epoch: peer.epoch,
          sequence,
          tick,
          input: { buttons, axes: 0, analog: false },
        });
      }
      return tick;
    });
    await waitTick(clients[0], intended + 10);
    const tap = await clients[0].evaluate(
      ({ intended, slot }) =>
        peer.frames
          .filter((frame) => frame.tick >= intended && frame.tick < intended + 10)
          .map((frame) => frame.inputs[slot].buttons),
      { intended, slot },
    );
    assert.deepEqual(
      tap,
      [0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      "Batched tap or duplicate changed its semantics",
    );
    const held = await target.evaluate(() => {
      const tick = peer.tick + 18;
      // Distinct edges must reach server validation; analog-only runs may be
      // superseded before entering the wire and therefore need no server ACK.
      for (const [sequence, intended, buttons] of [
        [3, 0, 0x40],
        [4, tick + 500, 0],
        [5, tick, 0x40],
      ]) {
        peer.socket.send({
          type: "input",
          epoch: peer.epoch,
          sequence,
          tick: intended,
          input: { buttons, axes: 0, analog: false },
        });
      }
      return tick;
    });
    await waitTick(clients[0], held + 14);
    const stale = await clients[0].evaluate(
      ({ held, slot }) =>
        peer.frames
          .filter((frame) => frame.tick >= held && frame.tick < held + 14)
          .map((frame) => frame.inputs[slot].buttons),
      { held, slot },
    );
    assert.deepEqual(
      stale,
      [...Array(9).fill(0x40), ...Array(5).fill(0)],
      "Stale controls did not expire after nine ticks",
    );
    const rejected = await target.evaluate(() =>
      peer.rejected.map((rejection) => rejection.reason),
    );
    assert.deepEqual(rejected, ["late", "future"]);
    const cdp = await target.context().newCDPSession(target);
    const before = await clients[0].evaluate(() => peer.tick);
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    await clients[0].waitForTimeout(1200);
    const during = await clients[0].evaluate(() => peer.tick);
    assert.ok(during - before >= 25, "Suspended peer slowed authoritative combat");
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await waitTick(target, during + 5);
    const stats = await target.evaluate(() => ({
      network: peer.socket.diagnostics(),
      errors: peer.errors,
      frames: Module._WebGetPresentedFrames(),
    }));
    assert.deepEqual(stats.errors, []);
    assert.equal(stats.frames, 0);
    await target.close();
    await waitTick(clients[0], during + 50);
    for (const client of clients.slice(0, -1))
      assert.deepEqual(await client.evaluate(() => peer.errors), []);
    assert.equal(authorityError, undefined);
    console.log(
      "PASS:",
      count,
      "clients; native batched tap/duplicate, late/future rejection, stale expiry, 100±30 ms receive delay, 1.2 s suspension/catch-up, disconnect survival",
      stats.network,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
