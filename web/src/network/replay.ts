import type { Input, NetworkEngine, NetworkPort, RoundState } from "./protocol.ts";
import { enqueueStep, stateSections } from "./protocol.ts";

export const replaySchema = 1;
export const maxReplayTicks = 900;
const maxChunkTicks = 24;
const maxBatchTicks = 24;
const batchBudgetMs = 8;

export type ReplayBegin = {
  type: "recovery_begin";
  schema: number;
  epoch: number;
  ticks: number;
  initial_digest: number;
  checksum: number;
};

export type ReplayFrame = { inputs: Input[]; digest: number; sections: RoundState["sections"] };
export type ReplayChunk = {
  type: "recovery_frames";
  start: number;
  frames: ReplayFrame[];
};

function integer(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function validFrame(frame: ReplayFrame, players: number): boolean {
  return (
    frame != null &&
    integer(frame.digest, 0xffffffff) &&
    Array.isArray(frame.sections) &&
    frame.sections.length === stateSections.length &&
    frame.sections.every((section) => integer(section, 0xffffffff)) &&
    Array.isArray(frame.inputs) &&
    frame.inputs.length === players &&
    frame.inputs.every(
      (input) =>
        input != null &&
        integer(input.buttons, 0xffff) &&
        integer(input.axes, 0xffffffff) &&
        typeof input.analog === "boolean",
    )
  );
}

function replayChecksum(frames: ReplayFrame[]): number {
  let hash = 2166136261;
  const word = (value: number) => {
    for (let shift = 0; shift < 32; shift += 8)
      hash = Math.imul(hash ^ ((value >>> shift) & 255), 16777619);
  };
  for (const frame of frames) {
    word(frame.digest);
    for (const section of frame.sections) word(section);
    for (const input of frame.inputs) {
      word(input.buttons);
      word(input.axes);
      word(+input.analog);
    }
  }
  return hash >>> 0;
}

export class ReplayCheckpoint {
  readonly ticks: number;
  readonly #initialDigest: number;
  readonly #checksum: number;
  readonly #players: number;
  readonly #frames: ReplayFrame[] = [];

  constructor(header: ReplayBegin, epoch: number, players: number, initialDigest: number) {
    if (
      header.schema !== replaySchema ||
      header.epoch !== epoch ||
      !integer(players, 8) ||
      players < 2 ||
      !integer(header.ticks, maxReplayTicks) ||
      header.ticks === 0 ||
      !integer(header.initial_digest, 0xffffffff) ||
      header.initial_digest !== initialDigest ||
      !integer(header.checksum, 0xffffffff)
    )
      throw new Error("Incompatible replay checkpoint");
    this.ticks = header.ticks;
    this.#initialDigest = initialDigest;
    this.#checksum = header.checksum;
    this.#players = players;
  }

  add(chunk: ReplayChunk): boolean {
    if (
      chunk.start !== this.#frames.length ||
      !Array.isArray(chunk.frames) ||
      chunk.frames.length === 0 ||
      chunk.frames.length > maxChunkTicks ||
      chunk.start + chunk.frames.length > this.ticks ||
      !chunk.frames.every((frame) => validFrame(frame, this.#players))
    )
      throw new Error("Invalid replay checkpoint input block");
    this.#frames.push(...chunk.frames);
    return this.#frames.length === this.ticks;
  }

  async restore(engine: NetworkEngine, port: NetworkPort, signal: AbortSignal) {
    if (this.#frames.length !== this.ticks) throw new Error("Incomplete replay checkpoint");
    if (replayChecksum(this.#frames) !== this.#checksum)
      throw new Error("Corrupt replay checkpoint");
    signal.throwIfAborted();
    if (!engine._WebNetBeginReplay())
      throw new Error(port.netSession?.message ?? "The game refused replay initialization");
    const verify = (tick: number, digest: number, sections?: RoundState["sections"]) => {
      const state = port.netMatch;
      const differences = sections
        ? stateSections.filter((_, i) => state?.sections?.[i] !== sections[i])
        : [];
      if (
        state?.tick !== tick ||
        state.digest !== digest ||
        state.unsupported !== null ||
        differences.length
      ) {
        const detail = state?.unsupported || differences.join(", ");
        throw new Error(
          "Replay checkpoint disagrees at tick " + tick + (detail ? " (" + detail + ")" : ""),
        );
      }
    };
    const end = () => engine._WebNetEndReplay();
    signal.addEventListener("abort", end, { once: true });
    try {
      verify(0, this.#initialDigest);
      let tick = 0;
      while (tick < this.ticks) {
        signal.throwIfAborted();
        const batchEnd = Math.min(tick + maxBatchTicks, this.ticks);
        const deadline = performance.now() + batchBudgetMs;
        do {
          const frame = this.#frames[tick]!;
          enqueueStep(engine, { type: "step", tick, inputs: frame.inputs });
          verify(++tick, frame.digest, frame.sections);
        } while (tick < batchEnd && performance.now() < deadline);
        if (tick < this.ticks) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      signal.removeEventListener("abort", end);
      if (!signal.aborted) end();
    }
  }
}
