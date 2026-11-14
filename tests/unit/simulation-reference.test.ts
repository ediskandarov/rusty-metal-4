import { expect, test } from "bun:test";

import { observeAcceptedFrames } from "../browser/simulation_reference.mjs";

test("the browser oracle uses exact authority identities, including reused and high IDs", async () => {
  for (const participants of [
    // Reservation 2 was cancelled and replaced by 4; the unaffected bindings retain 1 and 3.
    ["0000000000000001", "0000000000000004", "0000000000000003"],
    ["fffffffffffffffd", "0020000000000001", "000000000000004d"],
  ]) {
    let receive: (records: unknown[]) => void = () => {};
    const calls: { name: string; values: unknown[] }[] = [];
    const previous = Object.getOwnPropertyDescriptor(globalThis, "Module");
    Object.defineProperty(globalThis, "Module", {
      configurable: true,
      value: {
        ccall(name: string, _result: string, _types: string[], values: unknown[]) {
          calls.push({ name, values });
          return name === "WebNetWorldIndex" ? 0 : 1;
        },
      },
    });
    try {
      const client = {
        exposeFunction(_name: string, callback: typeof receive) {
          receive = callback;
          return Promise.resolve();
        },
        route() {
          return Promise.resolve();
        },
      };
      const reference = {
        evaluate(callback: (start: unknown) => unknown, start: unknown) {
          return Promise.resolve(callback(start));
        },
      };
      const observer = await observeAcceptedFrames(reference, [client]);
      receive([
        {
          type: "prediction_prepare",
          mode: "ffa",
          respawnDelayTicks: 90,
          modelPool: ["Orbital", "Pizza Boy", "Crusher"],
          capacity: 8,
          slots: [0, 3, 7],
          participants,
          world: "Construction Yard",
          cars: ["Orbital", "Pizza Boy", "Crusher"],
          seed: 12345,
          portable: true,
        },
      ]);
      await observer.settled();
      expect(calls.find(({ name }) => name === "WebNetStartFfa")?.values[7]).toBe(
        participants.join("\n"),
      );
    } finally {
      if (previous) Object.defineProperty(globalThis, "Module", previous);
      else Reflect.deleteProperty(globalThis, "Module");
    }
  }
});
