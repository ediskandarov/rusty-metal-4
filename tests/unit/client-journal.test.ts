import { describe, expect, test } from "bun:test";

import { ClientJournal } from "../../packages/game-runtime/src/network/journal.ts";
import { attachLivePrediction } from "../../packages/game-runtime/src/network/livePrediction.ts";
import type {
  NetworkEngine,
  NetworkPort,
} from "../../packages/game-runtime/src/network/protocol.ts";

describe("client diagnostic journal", () => {
  test("retains repeated ticks in event order and owns copies", () => {
    const j = new ClientJournal();
    const data = { buttons: 1 };
    j.record("input", 9, data);
    data.buttons = 2;
    j.record("restore", 8, { from: 9 });
    j.record("input", 9, data);
    expect(j.export().events.map((e) => e.data)).toEqual([
      { buttons: 1 },
      { from: 9 },
      { buttons: 2 },
    ]);
    expect(j.export().events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    for (let i = 10; i <= 310; i++) j.record("step", i, {});
    expect(j.export().events[0]!.tick).toBe(11);
  });
  test("bounds bytes even if simulation stops advancing, freezes before cleanup", () => {
    const j = new ClientJournal();
    for (let i = 0; i < 300; i++) j.record("input", 1, { value: "x".repeat(10000) });
    expect(JSON.stringify(j.export()).length).toBeLessThan(2 * 1024 * 1024 + 1000);
    expect(j.export().droppedEvents).toBeGreaterThan(0);
    j.freeze("desync", { head: 1 });
    const before = j.export().events;
    j.record("step", 2, {});
    j.freeze("closed", null);
    expect(j.export().events).toEqual(before);
    expect(j.export().stopped).toBe("desync");
    expect(before.at(-1)!.kind).toBe("stop");
  });
  test("bridge records authority, applied inputs, execution and rollback without replacing history", () => {
    const journal = new ClientJournal();
    const port: NetworkPort = {
      netMatch: { tick: 0, digest: 10, sections: [1, 2, 3, 4, 5], unsupported: null },
    };
    const engine = {
      _WebNetLocalRollbackDepth: () => 30,
      _WebNetRestoreLocalTick: (tick: number) => {
        port.netMatch!.tick = tick;
        return 1;
      },
      _WebNetSetInput: () => 1,
      _WebNetQueueTick: (tick: number) => {
        port.netMatch!.tick = tick + 1;
        return 1;
      },
      _WebNetFinishLocalReplay: () => 1,
    } as unknown as NetworkEngine;
    const handle = attachLivePrediction(engine, port, journal);
    try {
      const bridge = globalThis.tm4LivePrediction!;
      bridge.stage_live_input(0, 0, 65, 0, false);
      bridge.step_live_tick(0);
      bridge.restore_live_tick(0);
      bridge.stage_live_input(0, 0, 0, 0, false);
      bridge.step_live_tick(0);
      bridge.finish_live_replay();
      bridge.journal_authority_frame(
        JSON.stringify({
          frame: {
            tick: 0,
            changes: [],
            inputs: [{ buttons: 0, axes: 0, analog: false }],
            state: {
              remaining: 2,
              winner: -1,
              roundFinished: false,
              acceptsContinue: false,
              nextMode: 0,
              digest: 999,
              sections: [1, 2, 3, 4, 5],
              unsupported: null,
              scores: [],
            },
          },
        }),
      );
      const events = journal.export().events;
      expect(
        events.filter((e) => e.kind === "step").map((e) => (e.data as { replay: boolean }).replay),
      ).toEqual([false, true]);
      expect(events.find((e) => e.kind === "restore")!.data).toEqual({ restored: true, from: 1 });
      expect(events.filter((e) => e.kind === "input")).toHaveLength(2);
      expect(events.find((e) => e.kind === "authority")!.tick).toBe(1);
      expect(events.find((e) => e.kind === "authority")!.data).toMatchObject({
        type: "frame",
        tick: 0,
        state: { digest: 999 },
      });
      expect(() => bridge.journal_authority_frame("not json")).not.toThrow();
      expect(() => bridge.journal_authority_frame('{"frame":{}}')).not.toThrow();
      expect(journal.export().events.filter((e) => e.kind === "journal-error")).toHaveLength(2);
      expect(bridge.stage_live_input(1, 0, 0, 0, false)).toBe(true);
      expect(bridge.step_live_tick(1)).toBe(true);
      expect(port.netMatch!.tick).toBe(2);
    } finally {
      handle.close();
    }
  });
});
