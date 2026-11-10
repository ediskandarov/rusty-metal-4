import type { NetworkEngine, NetworkPort } from "./protocol.ts";
import { stateSections } from "./protocol.ts";

export const replaySchema = 2;
const maxChunkTicks = 64;
const maxQueuedChunks = 4;
const framePrefix = 29;
const inputBytes = 7;
const maxReplayTicks = Math.floor((1024 * 1024 * 1024 - 8192) / (framePrefix + 8 * inputBytes + 5));
const maxBatchTicks = 24;
const batchBudgetMs = 8;

export type ReplayBegin = {
  type: "recovery_begin";
  schema: number;
  epoch: number;
  head: number;
  initial_digest: number;
};

export type ReplayChunk = {
  type: "recovery_frames";
  start: number;
  head: number;
  data: number[];
  checksum: number;
};

function integer(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function checksum(data: Uint8Array): number {
  let hash = 2166136261;
  for (const byte of data) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
}

export class ReplayJournal {
  readonly #engine: NetworkEngine;
  readonly #port: NetworkPort;
  readonly #signal: AbortSignal;
  readonly #initialDigest: number;
  readonly #players: number;
  readonly #width: number;
  #received = 0;
  #applied = 0;
  #head: number;
  #began = false;
  #queued = 0;
  #tail = Promise.resolve(0);

  constructor(
    header: ReplayBegin,
    epoch: number,
    players: number,
    initialDigest: number,
    engine: NetworkEngine,
    port: NetworkPort,
    signal: AbortSignal,
  ) {
    if (
      header.schema !== replaySchema ||
      header.epoch !== epoch ||
      !integer(players, 8) ||
      players < 2 ||
      !integer(header.head, maxReplayTicks) ||
      header.head === 0 ||
      !integer(header.initial_digest, 0xffffffff) ||
      header.initial_digest !== initialDigest
    )
      throw new Error("Incompatible match journal");
    this.#engine = engine;
    this.#port = port;
    this.#signal = signal;
    this.#initialDigest = initialDigest;
    this.#players = players;
    this.#width = framePrefix + inputBytes * players;
    this.#head = header.head;
  }

  accept(chunk: ReplayChunk): Promise<number> {
    const count = Array.isArray(chunk.data) ? chunk.data.length / this.#width : NaN;
    if (
      chunk.start !== this.#received ||
      !integer(count, maxChunkTicks) ||
      count === 0 ||
      !integer(chunk.head, maxReplayTicks) ||
      chunk.head < this.#head ||
      chunk.start + count > chunk.head ||
      this.#queued >= maxQueuedChunks ||
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
    this.#head = chunk.head;
    this.#received += count;
    this.#queued++;
    this.#tail = this.#tail.then(() => this.#apply(data)).finally(() => this.#queued--);
    return this.#tail;
  }

  finish(tick: number) {
    if (
      !this.#began ||
      tick !== this.#head ||
      tick !== this.#applied ||
      tick !== this.#received ||
      this.#queued
    )
      throw new Error("Incomplete match journal stream");
    this.#signal.removeEventListener("abort", this.#end);
    this.#end();
  }

  #end = () => {
    if (!this.#began) return;
    this.#began = false;
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
    if (!this.#began) {
      if (!engine._WebNetBeginReplay())
        throw new Error(this.#port.netSession?.message ?? "The game refused replay initialization");
      this.#began = true;
      signal.addEventListener("abort", this.#end, { once: true });
      this.#verify(0, this.#initialDigest);
    }
    const frame = new DataView(data.buffer);
    let row = 0;
    while (row < data.length) {
      signal.throwIfAborted();
      const batchEnd = Math.min(row + maxBatchTicks * this.#width, data.length);
      const deadline = performance.now() + batchBudgetMs;
      do {
        const tick = this.#applied;
        let input = row + framePrefix;
        for (let slot = 0; slot < this.#players; slot++, input += inputBytes) {
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
