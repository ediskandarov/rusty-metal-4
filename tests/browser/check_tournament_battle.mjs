/* global Module, tm4Port */
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error(e.message));
  await page.goto(
    new URL(
      "?simulation-reference=1&checkpoint=1",
      process.env.TM4_WEB_URL ?? "http://127.0.0.1:8080/",
    ).href,
  );
  await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
  const result = await page.evaluate(async () => {
    const check = (v, msg) => {
      if (!v) throw Error(msg);
    };
    check(
      await Module.ccall(
        "WebNetStartTournament",
        "number",
        ["number", "number", "number", "number", "number", "number", "string", "string"],
        [8, 3, 0, 12345, -1, 1, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
        { async: true },
      ),
      "start",
    );
    Module._WebTestReadMatchState();
    const initial = structuredClone(tm4Port.match);
    const step = () => {
      const tick = tm4Port.netMatch.tick;
      check(Module._WebNetSetInput(tick, 0, 0x40, 0, 0), "input0");
      check(Module._WebNetSetInput(tick, 1, 0, 0, 0), "input1");
      check(Module._WebNetQueueTick(tick), "tick");
      check(!tm4Port.netMatch.unsupported, "unsupported " + tm4Port.netMatch.unsupported);
      return tm4Port.netMatch.sections;
    };
    for (let i = 0; i < 60; i++) step();
    Module._WebTestDamagePlayer();
    step();
    for (let i = 0; i < 60; i++) step();
    Module._WebTestReadMatchState();
    const death = structuredClone(tm4Port.match);
    check(Module._WebNetCapturePortableCheckpoint(), "portable " + tm4Port.portableCheckpointError);
    const portable = Array.from(tm4Port.portableCheckpoint);
    check(Module._WebNetCaptureLocalCheckpoint(), "local " + tm4Port.localCheckpointError);
    const forward = Array.from({ length: 240 }, step);
    Module._WebTestReadMatchState();
    const respawn = structuredClone(tm4Port.match);
    check(Module._WebTestCarHandle(0) > 0, "player respawned");
    check(Module._WebTestRespawnState(0, 0) === 0, "participant has active car");
    check(Module._WebNetRestoreLocalCheckpoint(), "restore " + tm4Port.localCheckpointError);
    const repeated = Array.from({ length: 240 }, step);
    check(JSON.stringify(forward) === JSON.stringify(repeated), "rollback diverged");
    check(Module._WebNetFinishLocalReplay(), "finish");
    return { initial, death, respawn, bytes: portable.length, portable, forward };
  });
  assert.equal(result.initial.lives, 4);
  assert(result.initial.opponents > 0);
  assert.equal(result.respawn.lives, 3);
  const fresh = await browser.newPage();
  await fresh.addInitScript(() => {
    globalThis.tm4TestShiftResourceHeap = true;
  });
  await fresh.goto(
    new URL(
      "?simulation-reference=1&checkpoint=1",
      process.env.TM4_WEB_URL ?? "http://127.0.0.1:8080/",
    ).href,
  );
  await fresh.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
  const recovered = await fresh.evaluate(async (portable) => {
    if (
      !(await Module.ccall(
        "WebNetStartTournament",
        "number",
        ["number", "number", "number", "number", "number", "number", "string", "string"],
        [8, 3, 0, 12345, -1, 1, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
        { async: true },
      ))
    )
      throw Error("fresh start");
    tm4Port.portableCheckpoint = Uint8Array.from(portable);
    if (!Module._WebNetBeginPortableReplay())
      throw Error("portable restore " + tm4Port.portableCheckpointError);
    Module._WebNetEndReplay();
    return Array.from({ length: 240 }, () => {
      const tick = tm4Port.netMatch.tick;
      Module._WebNetSetInput(tick, 0, 0x40, 0, 0);
      Module._WebNetSetInput(tick, 1, 0, 0, 0);
      if (!Module._WebNetQueueTick(tick)) throw Error("recovered tick");
      return tm4Port.netMatch.sections;
    });
  }, result.portable);
  assert.deepEqual(recovered, result.forward);
  console.log(
    JSON.stringify({
      initial: result.initial,
      death: result.death,
      respawn: result.respawn,
      bytes: result.bytes,
    }),
  );

  const ending = await page.evaluate(async () => {
    const check = (value, message) => {
      if (!value) throw Error(message);
    };
    const step = () => {
      const tick = tm4Port.netMatch.tick;
      check(Module._WebNetSetInput(tick, 0, tick % 30 === 0 ? 0x40 : 0, 0, 0), "ending input0");
      check(Module._WebNetSetInput(tick, 1, 0, 0, 0), "ending input1");
      check(Module._WebNetQueueTick(tick), "ending step");
      check(!tm4Port.netMatch.unsupported, "ending unsupported: " + tm4Port.netMatch.unsupported);
      return structuredClone(tm4Port.netMatch);
    };
    check(Module._WebNetCaptureLocalCheckpoint(), "before victory capture");
    const win = () => {
      Module._WebTestDefeatOpponents();
      const records = [];
      for (let i = 0; i < 1200 && !tm4Port.netMatch.completion.reasons; i++) {
        if (i % 120 === 0) Module._WebTestDefeatOpponents();
        records.push(step());
      }
      Module._WebTestReadMatchState();
      check(
        tm4Port.netMatch.completion.reasons === 16,
        "original victory: " + JSON.stringify(tm4Port.match),
      );
      check(tm4Port.netMatch.completion.winners === 3, "team victory");
      return records.map((row) => [row.sections, row.completion]);
    };
    const victory = win();
    check(Module._WebNetRestoreLocalCheckpoint(), "before victory restore");
    const repeated = win();
    check(JSON.stringify(victory) === JSON.stringify(repeated), "victory rollback");
    check(Module._WebNetFinishLocalReplay(), "finish victory replay");
    check(
      Module._WebNetCapturePortableCheckpoint(),
      "victory snapshot: " + tm4Port.portableCheckpointError,
    );
    const portable = Array.from(tm4Port.portableCheckpoint);
    const terminal = step();
    for (let i = 0; i < 180; i++) step();
    check(!tm4Port.netMatch.nextMode, "must not run offline world transition");
    return { portable, terminal };
  });
  await fresh.reload();
  await fresh.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
  const finalState = await fresh.evaluate(async (portable) => {
    if (
      !(await Module.ccall(
        "WebNetStartTournament",
        "number",
        ["number", "number", "number", "number", "number", "number", "string", "string"],
        [8, 3, 0, 12345, -1, 1, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
        { async: true },
      ))
    )
      throw Error("terminal start");
    tm4Port.portableCheckpoint = Uint8Array.from(portable);
    if (!Module._WebNetBeginPortableReplay())
      throw Error("victory restore: " + tm4Port.portableCheckpointError);
    Module._WebNetEndReplay();
    const tick = tm4Port.netMatch.tick;
    Module._WebNetSetInput(tick, 0, 0, 0, 0);
    Module._WebNetSetInput(tick, 1, 0, 0, 0);
    if (!Module._WebNetQueueTick(tick)) throw Error("terminal step");
    return tm4Port.netMatch;
  }, ending.portable);
  assert.deepEqual(finalState.sections, ending.terminal.sections);
  assert.deepEqual(finalState.completion, ending.terminal.completion);
  console.log("PASS original team victory, rollback and portable terminal state");
  await fresh.reload();
  await fresh.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
  const defeat = await fresh.evaluate(async () => {
    const check = (v, m) => {
      if (!v) throw Error(m);
    };
    check(
      await Module.ccall(
        "WebNetStartTournament",
        "number",
        ["number", "number", "number", "number", "number", "number", "string", "string"],
        [8, 3, 0, 12345, -1, 1, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
        { async: true },
      ),
      "defeat start",
    );
    const step = () => {
      const tick = tm4Port.netMatch.tick;
      Module._WebNetSetInput(tick, 0, 0, 0, 0);
      Module._WebNetSetInput(tick, 1, 0, 0, 0);
      check(Module._WebNetQueueTick(tick), "defeat step");
      check(!tm4Port.netMatch.unsupported, "defeat unsupported: " + tm4Port.netMatch.unsupported);
      return structuredClone(tm4Port.netMatch.sections);
    };
    for (let i = 0; i < 5; i++) {
      check(Module._WebTestKillParticipant(0), "kill human0");
      for (let tick = 0; tick < 240; tick++) step();
    }
    Module._WebTestReadMatchState();
    check(
      tm4Port.match.lives === 0 && Module._WebTestCarHandle(0),
      "original shared lives must borrow from teammate",
    );
    let forward;
    const killAndStep = () => {
      for (let slot = 0; slot < 2; slot++)
        if (Module._WebTestCarHandle(slot)) Module._WebTestKillParticipant(slot);
      return Array.from({ length: 240 }, step);
    };
    for (let attempt = 0; attempt < 6 && !tm4Port.netMatch.completion.reasons; attempt++) {
      check(Module._WebNetCaptureLocalCheckpoint(), "defeat capture");
      forward = killAndStep();
    }
    check(
      tm4Port.netMatch.completion.reasons === 8 && !tm4Port.netMatch.completion.winners,
      "original defeat",
    );
    check(Module._WebNetRestoreLocalCheckpoint(), "defeat restore");
    check(JSON.stringify(killAndStep()) === JSON.stringify(forward), "defeat rollback");
    check(Module._WebNetFinishLocalReplay(), "defeat finish replay");
    check(
      Module._WebNetCapturePortableCheckpoint(),
      "defeat portable: " + tm4Port.portableCheckpointError,
    );
    return {
      portable: Array.from(tm4Port.portableCheckpoint),
      sections: step(),
      completion: tm4Port.netMatch.completion,
    };
  });
  await page.reload();
  await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
  const defeatRestored = await page.evaluate(async (portable) => {
    await Module.ccall(
      "WebNetStartTournament",
      "number",
      ["number", "number", "number", "number", "number", "number", "string", "string"],
      [8, 3, 0, 12345, -1, 1, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
      { async: true },
    );
    tm4Port.portableCheckpoint = Uint8Array.from(portable);
    if (!Module._WebNetBeginPortableReplay())
      throw Error("defeat portable restore: " + tm4Port.portableCheckpointError);
    Module._WebNetEndReplay();
    const tick = tm4Port.netMatch.tick;
    Module._WebNetSetInput(tick, 0, 0, 0, 0);
    Module._WebNetSetInput(tick, 1, 0, 0, 0);
    if (!Module._WebNetQueueTick(tick)) throw Error("restored defeat tick");
    return { sections: tm4Port.netMatch.sections, completion: tm4Port.netMatch.completion };
  }, defeat.portable);
  assert.deepEqual(defeatRestored.sections, defeat.sections);
  assert.deepEqual(defeatRestored.completion, defeat.completion);
  console.log("PASS shared lives, exhaustion, original defeat, rollback and portable recovery");

  // The same original GAME OVER renderer must also work with a visible network view.
  await page.goto(
    new URL("?session=1&checkpoint=1", process.env.TM4_WEB_URL ?? "http://127.0.0.1:8080/").href,
  );
  await page.waitForFunction(() => globalThis.tm4Port?.compatibility, null, { timeout: 90000 });
  await page.evaluate(async () => {
    if (
      !(await Module.ccall(
        "WebNetStartTournament",
        "number",
        ["number", "number", "number", "number", "number", "number", "string", "string"],
        [8, 3, 0, 12345, 0, 3, "Orbital\nPizza Boy", "0000000000000001\n0000000000000002"],
        { async: true },
      ))
    )
      throw Error("visible tournament start");
    for (let life = 0; life < 5; ++life) {
      for (let slot = 0; slot < 2; ++slot)
        if (Module._WebTestCarHandle(slot) && !Module._WebTestKillParticipant(slot))
          throw Error("visible defeat damage");
      for (let step = 0; step < 240; ++step) {
        const tick = tm4Port.netMatch.tick;
        Module._WebNetSetInput(tick, 0, 0, 0, 0);
        Module._WebNetSetInput(tick, 1, 0, 0, 0);
        if (!Module._WebNetQueueTick(tick)) throw Error("visible defeat tick");
      }
    }
    // Let the original double-buffered GPU submit and present multiple real frames.
    for (let frame = 0; frame < 10; ++frame) {
      const tick = tm4Port.netMatch.tick;
      Module._WebNetSetInput(tick, 0, 0, 0, 0);
      Module._WebNetSetInput(tick, 1, 0, 0, 0);
      if (!Module._WebNetQueueTick(tick)) throw Error("visible terminal tick");
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    Module._WebTestReadMatchState();
    if (!tm4Port.match.lost || tm4Port.netMatch.completion.reasons !== 8)
      throw Error("visible original GAME OVER");
  });
  await page.waitForFunction(() => tm4Port.levelFrames >= 8);
  await page
    .locator("canvas")
    .screenshot({ path: "build/checks/tournament-game-over-network.png" });
  console.log("PASS original GAME OVER renders on the network canvas");
  console.log("PASS original tournament, AI, death, respawn, rollback and portable recovery");
} finally {
  await browser.close();
}
