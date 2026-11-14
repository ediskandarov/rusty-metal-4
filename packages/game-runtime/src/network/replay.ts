import type { CatchupChunk } from "@tm4/lightyear-client/schemas";
import { type SlotConfiguration, slotConfigurationSchema } from "@tm4/lightyear-client/schemas";

import type { NetworkEngine, NetworkPort } from "./protocol.ts";
import { applyMembership, stateSections } from "./protocol.ts";
export type { CatchupChunk } from "@tm4/lightyear-client/schemas";

export const maxResumeTicks = 240;
const maxChunkTicks = 64;
const framePrefix = 118;
const inputBytes = 7;
const maxBatchTicks = 24;
const batchBudgetMs = 8;

function integer(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

export function checksum(data: Uint8Array): number {
  let hash = 2166136261;
  for (const byte of data) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
}

export class SnapshotReplay {
  readonly #engine: NetworkEngine;
  readonly #port: NetworkPort;
  readonly #signal: AbortSignal;
  readonly #capacity: number;
  readonly #cars: string[];
  readonly #width: number;
  readonly #start: number;
  #head: number;
  #applied: number;
  #ended = false;
  #applying = false;

  constructor(
    start: number,
    head: number,
    digest: number,
    configuration: SlotConfiguration & { modelPool: string[] },
    engine: NetworkEngine,
    port: NetworkPort,
    signal: AbortSignal,
  ) {
    const { capacity } = slotConfigurationSchema.parse(configuration);
    if (
      !integer(head, 0xffffffff) ||
      !integer(start, head) ||
      start === 0 ||
      head - start > maxResumeTicks ||
      !integer(digest, 0xffffffff)
    )
      throw new Error("Invalid reconnect replay boundary");
    signal.throwIfAborted();
    this.#engine = engine;
    this.#port = port;
    this.#signal = signal;
    this.#capacity = capacity;
    this.#cars = [...configuration.modelPool];
    if (
      this.#cars.length < 1 ||
      this.#cars.length > 8 ||
      this.#cars.some((car) => !car || car.includes("\0") || car.includes("\n"))
    )
      throw new Error("Invalid prepared journal model pool");
    this.#width = framePrefix + inputBytes * capacity;
    this.#start = start;
    this.#head = head;
    this.#applied = start;
    this.#verify(start, digest);
    signal.addEventListener("abort", this.#end, { once: true });
  }

  accept(chunk: CatchupChunk): Promise<number> {
    const count = Array.isArray(chunk.data) ? chunk.data.length / this.#width : NaN;
    if (
      this.#ended ||
      this.#applying ||
      chunk.start !== this.#applied ||
      !integer(count, maxChunkTicks) ||
      count === 0 ||
      chunk.head !== this.#head ||
      chunk.start + count > chunk.head ||
      !chunk.data.every((byte) => integer(byte, 255))
    )
      throw new Error("Invalid match journal block");
    const data = Uint8Array.from(chunk.data);
    if (checksum(data) !== chunk.checksum) throw new Error("Corrupt match journal block");
    for (let row = 0; row < data.length; row += this.#width) {
      if (data[row + 28] !== 0) throw new Error("Unsupported match journal frame");
      for (let input = row + framePrefix; input < row + this.#width; input += inputBytes)
        if (data[input + 6]! > 1) throw new Error("Invalid match journal controller flags");
    }
    this.#applying = true;
    return this.#apply(data).finally(() => {
      this.#applying = false;
    });
  }

  extend(start: number, head: number, digest: number) {
    if (
      this.#ended ||
      this.#applying ||
      start !== this.#applied ||
      start !== this.#head ||
      !integer(head, 0xffffffff) ||
      head <= start ||
      head - this.#start > maxResumeTicks
    )
      throw new Error("Invalid reconnect retarget boundary");
    this.#verify(start, digest);
    this.#head = head;
  }

  finish(tick: number) {
    if (this.#ended || this.#applying || tick !== this.#head || tick !== this.#applied)
      throw new Error("Incomplete reconnect replay");
    this.#signal.removeEventListener("abort", this.#end);
    this.#end();
  }

  #end = () => {
    if (this.#ended) return;
    this.#ended = true;
    this.#engine._WebNetEndReplay();
  };

  #verify(tick: number, digest: number, frame?: DataView, row = 0) {
    const state = this.#port.netMatch;
    const differences = frame
      ? stateSections.filter(
          (_, i) => state?.sections?.[i] !== frame.getUint32(row + 4 * (i + 1), true),
        )
      : [];
    if (
      state?.tick !== tick ||
      state.digest !== digest ||
      state.unsupported !== null ||
      (frame && state.nextMode !== frame.getInt32(row + 24, true)) ||
      differences.length
    ) {
      const detail = state?.unsupported || differences.join(", ");
      throw new Error(
        "Match journal disagrees at tick " + tick + (detail ? " (" + detail + ")" : ""),
      );
    }
  }

  async #apply(data: Uint8Array<ArrayBuffer>): Promise<number> {
    const engine = this.#engine;
    const signal = this.#signal;
    signal.throwIfAborted();
    const frame = new DataView(data.buffer);
    let row = 0;
    while (row < data.length) {
      signal.throwIfAborted();
      const batchEnd = Math.min(row + maxBatchTicks * this.#width, data.length);
      const deadline = performance.now() + batchBudgetMs;
      do {
        const tick = this.#applied;
        const count = frame.getUint8(row + 29);
        if (count > 8) throw new Error("Invalid membership journal count");
        const changes = [];
        for (let index = 0; index < 8; ++index) {
          const entry = row + 30 + index * 11;
          if (index >= count) {
            if (data.subarray(entry, entry + 11).some((byte) => byte !== 0))
              throw new Error("Invalid membership journal padding");
            continue;
          }
          const kind = frame.getUint8(entry);
          const slot = frame.getUint8(entry + 1);
          const participant = frame
            .getBigUint64(entry + 2, true)
            .toString(16)
            .padStart(16, "0");
          const model = frame.getUint8(entry + 10);
          if (slot >= this.#capacity || (kind !== 1 && kind !== 2) || (kind === 2 && model !== 0))
            throw new Error("Invalid membership journal decision");
          const identity = { slot, participant };
          changes.push(
            kind === 1
              ? { kind: "admit", identity, car: this.#cars[model] }
              : { kind: "depart", identity },
          );
        }
        if (!applyMembership(engine, tick, changes))
          throw new Error("The game refused journal membership at tick " + tick);
        const slotMask = engine.ccall("WebNetSlotMask", "number", [], []);
        let input = row + framePrefix;
        for (let slot = 0; slot < this.#capacity; slot++, input += inputBytes) {
          if (!(slotMask & (1 << slot))) continue;
          if (
            !engine._WebNetSetInput(
              tick,
              slot,
              frame.getUint16(input, true),
              frame.getUint32(input + 2, true),
              frame.getUint8(input + 6),
            )
          )
            throw new Error("The game refused journal input at tick " + tick);
        }
        if (!engine._WebNetQueueTick(tick))
          throw new Error("The game refused journal tick " + tick);
        this.#verify(++this.#applied, frame.getUint32(row, true), frame, row);
        row += this.#width;
      } while (row < batchEnd && performance.now() < deadline);
      if (row < data.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return this.#applied;
  }
}
