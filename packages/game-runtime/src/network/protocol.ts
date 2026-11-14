import type { NetworkDiagnostics } from "@tm4/lightyear-client";
import { membershipChangesSchema, startSchema } from "@tm4/lightyear-client/schemas";
import type { Compatibility, RoundState, Start } from "@tm4/lightyear-client/schemas";
export type {
  Input,
  Compatibility,
  Start,
  Score,
  RoundState,
  Frame,
} from "@tm4/lightyear-client/schemas";
export const stateSections = ["session", "cars", "objects", "world", "sound"] as const;
export interface NetworkEngine {
  ccall(name: string, result: string, types: string[], values: (string | number)[]): number;
  _WebNetSetInput(
    tick: number,
    slot: number,
    buttons: number,
    axes: number,
    analog: number,
  ): number;
  _WebNetQueueTick(tick: number): number;
  _WebNetCancelMatch(): void;
  _WebNetEndReplay(): void;
  _WebNetBeginPortableReplay(): number;
}

export function hasNetworkEngine(runtime: Partial<NetworkEngine>): runtime is NetworkEngine {
  return (
    typeof runtime.ccall === "function" &&
    typeof runtime._WebNetSetInput === "function" &&
    typeof runtime._WebNetQueueTick === "function" &&
    typeof runtime._WebNetCancelMatch === "function" &&
    typeof runtime._WebNetEndReplay === "function" &&
    typeof runtime._WebNetBeginPortableReplay === "function"
  );
}

export interface NetworkPort {
  screen?: string;
  platformReady?: boolean;
  compatibility?: Compatibility;
  catalog?: { worlds: string[]; cars: string[] };
  menuReady?: boolean;
  netSession?: { status: "loading" | "ready" | "error"; message?: string };
  netMatch?: { tick: number; respawn?: { state: number; dueTick: number } } & Partial<RoundState>;
  portableCheckpoint?: Uint8Array<ArrayBuffer>;
  portableCheckpointError?: string | null;
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
    receivedFrames: number;
    transportActive?: boolean;
    transportSampledAt?: number;
    clockOffers?: number;
    recoveredTick?: number;
    snapshotTick?: number;
    snapshotBytes?: number;
    replayBytes?: number;
    replayChunks?: number;
    replayMs?: number;
    resumeRetargets?: number;
    transport?: NetworkDiagnostics;
    transportError?: string;
  };
}

export function configureMatch(engine: NetworkEngine, proposed: Start, view: number) {
  const start = startSchema.parse(proposed);
  if (!Number.isInteger(view) || view < 0 || view >= start.capacity)
    throw new Error("Invalid local gameplay slot");
  const world = engine.ccall("WebNetWorldIndex", "number", ["string"], [start.world]);
  if (world < 0) throw new Error("Session map is missing locally");
  return engine.ccall(
    "WebNetStartFfa",
    "number",
    [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "string",
      "string",
      "number",
      "string",
    ],
    [
      start.capacity,
      start.slots.reduce((mask, slot) => mask | (1 << slot), 0),
      world,
      start.seed,
      view,
      2 | (start.portable ? 1 : 0),
      start.cars.join("\n"),
      start.participants.join("\n"),
      start.respawnDelayTicks,
      start.modelPool.join("\n"),
    ],
  );
}

/** Apply the authority's complete, ordered membership decisions before this input row. */
export function applyMembership(engine: NetworkEngine, tick: number, proposed: unknown): boolean {
  const changes = membershipChangesSchema.parse(proposed);
  for (const change of changes) {
    const id = BigInt("0x" + change.identity.participant);
    const values = [tick, change.identity.slot, Number(id & 0xffffffffn), Number(id >> 32n)];
    const accepted =
      change.kind === "admit"
        ? engine.ccall(
            "WebNetAdmitParticipant",
            "number",
            ["number", "number", "number", "number", "string"],
            [...values, change.car],
          )
        : engine.ccall(
            "WebNetDepartParticipant",
            "number",
            ["number", "number", "number", "number"],
            values,
          );
    // A failed initial car preparation leaves the reservation unpublished. The
    // authority retires that reservation; its unchanged state is still verified.
    if (!accepted && change.kind === "depart") return false;
  }
  return true;
}
