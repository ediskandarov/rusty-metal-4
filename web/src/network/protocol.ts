export type Input = { buttons: number; axes: number; analog: boolean };
export type Start = { type: "start"; players: number; world: number; seed: number };
export type Step = { type: "step"; tick: number; inputs: Input[] };
export type Score = { wins: number; losses: number };
export type RoundState = {
  remaining: number;
  winner: number;
  roundFinished: boolean;
  acceptsContinue: boolean;
  nextMode: number;
  digest: number;
  scores: Score[];
};
export type Frame = Omit<Step, "type"> & { type: "frame"; state: RoundState };

export interface NetworkEngine {
  _WebNetRequestMatch(players: number, world: number, seed: number, viewSlot: number): number;
  _WebNetSetInput(
    tick: number,
    slot: number,
    buttons: number,
    axes: number,
    analog: number,
  ): number;
  _WebNetQueueTick(tick: number): number;
  _WebNetCancelMatch(): void;
}

export function hasNetworkEngine(runtime: Partial<NetworkEngine>): runtime is NetworkEngine {
  return (
    typeof runtime._WebNetRequestMatch === "function" &&
    typeof runtime._WebNetSetInput === "function" &&
    typeof runtime._WebNetQueueTick === "function" &&
    typeof runtime._WebNetCancelMatch === "function"
  );
}

export interface NetworkPort {
  screen?: string;
  menuReady?: boolean;
  netMatch?: { tick: number } & Partial<RoundState>;
  netMatchTick?: () => void;
  netMatchInput?: (buttons: number, axes: number, analog: boolean) => void;
  netMatchServerState?: RoundState;
}

export function enqueueStep(engine: NetworkEngine, step: Step | Frame) {
  for (const [slot, input] of step.inputs.entries()) {
    if (!engine._WebNetSetInput(step.tick, slot, input.buttons, input.axes, +input.analog))
      throw new Error("The game refused input for tick " + step.tick);
  }
  if (!engine._WebNetQueueTick(step.tick))
    throw new Error("The game refused to run tick " + step.tick);
}
