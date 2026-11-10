export type Input = { buttons: number; axes: number; analog: boolean };
export type Compatibility = { protocol: number; build: string; content: string };
export type Start = {
  type: "start";
  players: number;
  world: string;
  cars: string[];
  seed: number;
  epoch: number;
  compatibility: Compatibility;
  portable?: boolean;
};
export type Step = { type: "step"; tick: number; inputs: Input[] };
export const stateSections = ["session", "cars", "objects", "world", "sound"] as const;
export type Score = { wins: number; losses: number };
export type RoundState = {
  remaining: number;
  winner: number;
  roundFinished: boolean;
  acceptsContinue: boolean;
  nextMode: number;
  digest: number;
  sections: [number, number, number, number, number];
  unsupported: string | null;
  scores: Score[];
};
export type Frame = Omit<Step, "type"> & {
  type: "frame";
  state: RoundState;
  fallback_processed: (number | null)[];
};

export interface NetworkEngine {
  ccall(name: string, result: string, types: string[], values: (string | number)[]): number;
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
  _WebNetBeginReplay(): number;
  _WebNetEndReplay(): void;
  _WebNetEnablePortableCheckpoint?(): number;
  _WebNetCapturePortableCheckpoint?(): number;
  _WebNetBeginPortableReplay?(): number;
}

export function hasNetworkEngine(runtime: Partial<NetworkEngine>): runtime is NetworkEngine {
  return (
    typeof runtime._WebNetRequestMatch === "function" &&
    typeof runtime._WebNetSetInput === "function" &&
    typeof runtime._WebNetQueueTick === "function" &&
    typeof runtime._WebNetCancelMatch === "function" &&
    typeof runtime._WebNetBeginReplay === "function" &&
    typeof runtime._WebNetEndReplay === "function"
  );
}

export interface NetworkPort {
  screen?: string;
  platformReady?: boolean;
  compatibility?: Compatibility;
  catalog?: { worlds: string[]; cars: string[] };
  menuReady?: boolean;
  netSession?: { status: "loading" | "ready" | "error"; message?: string };
  netMatch?: { tick: number } & Partial<RoundState>;
  portableCheckpoint?: Uint8Array<ArrayBuffer>;
  portableCheckpointError?: string | null;
  netMatchTick?: () => void;
  netMatchInput?: (buttons: number, axes: number, analog: boolean) => void;
  netMatchServerState?: RoundState;
  netConfirmedTick?: number;
  netPredictionCost?: {
    captures: number;
    captureMs: number;
    restores: number;
    restoreMs: number;
    maxRestoreMs: number;
    steps: number;
    stepMs: number;
    replayStepMs: number;
    maxRollbackMs: number;
  };
  netDiagnostics?: {
    pendingInputs: number;
    rejectedInputs: number;
    processedSequence: number;
    receivedFrames: number;
    clockOffers?: number;
    recoveredTick?: number;
    snapshotTick?: number;
    snapshotBytes?: number;
    replayBytes?: number;
    replayChunks?: number;
    replayMs?: number;
    divergence?: string[];
    transport: {
      rttMs: number;
      jitterMs: number;
      queuedPackets: number;
      pendingInputs: number;
      nativeTick: number;
      pump: {
        pollGapMs: number;
        maxPollGapMs: number;
        maxUpdateMs: number;
        visibility: DocumentVisibilityState;
      };
      prediction?: {
        head: number;
        confirmed: number;
        rollbacks: number;
        windowWaits: number;
        waitingForInput: boolean;
        acceptedDepth: number;
        replayed: number;
        maxDepth: number;
        historyBytes: number;
        peakBytes: number;
        buttonEdges: number;
      };
    };
  };
}

export function enqueueStep(engine: NetworkEngine, step: Step | Frame) {
  for (const [slot, input] of step.inputs.entries()) {
    if (!engine._WebNetSetInput(step.tick, slot, input.buttons, input.axes, +input.analog))
      throw new Error("The game refused input for tick " + step.tick);
  }
  if (!engine._WebNetQueueTick(step.tick))
    throw new Error("The game refused to run tick " + step.tick);
}

export function configureMatch(engine: NetworkEngine, start: Start, view: number) {
  const world = engine.ccall("WebNetWorldIndex", "number", ["string"], [start.world]);
  if (world < 0 || start.cars.length !== start.players)
    throw new Error("Session resources are missing locally");
  for (const [slot, car] of start.cars.entries()) {
    if (!engine.ccall("WebNetSelectCar", "number", ["number", "string"], [slot, car]))
      throw new Error("Missing local car: " + car);
  }
  if (start.portable && !engine._WebNetEnablePortableCheckpoint?.())
    throw new Error("Portable checkpoints are unavailable for this match");
  return engine._WebNetRequestMatch(start.players, world, start.seed, view);
}
