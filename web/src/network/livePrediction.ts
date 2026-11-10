import type { NetworkEngine, NetworkPort } from "./protocol.ts";

interface PredictionEngine extends NetworkEngine {
  _WebNetEnableRenderedPrediction(): number;
  _WebNetRetainLocalCheckpoint(tick: number): number;
  _WebNetLocalCheckpointStorageBytes(): number;
  _WebNetLocalRollbackDepth(): number;
  _WebNetRestoreLocalTick(tick: number): number;
  _WebNetFinishLocalReplay(): number;
  _WebNetConfirmPresentationTick(tick: number): number;
  _WebNetSetPresentationPhase(phase: number, correction: number): void;
}

interface Bridge {
  retain_live_tick(tick: number): number;
  restore_live_tick(tick: number): boolean;
  stage_live_input(
    tick: number,
    slot: number,
    buttons: number,
    axes: number,
    analog: boolean,
  ): boolean;
  step_live_tick(tick: number): boolean;
  live_digest_section(index: number): number;
  finish_live_replay(): number;
  set_live_presentation_phase(phase: number, correction: number): void;
}

declare global {
  var tm4LivePrediction: Bridge | undefined;
}

export function attachLivePrediction(runtime: NetworkEngine, port: NetworkPort) {
  const engine = runtime as PredictionEngine;
  if (globalThis.tm4LivePrediction || !engine._WebNetEnableRenderedPrediction?.())
    throw new Error("Live rollback is unavailable for this game or its mods");

  delete port.netConfirmedTick;
  delete port.netMatchServerState;
  let replayStarted: number | undefined;
  const cost = (port.netPredictionCost = {
    captures: 0,
    captureMs: 0,
    restores: 0,
    restoreMs: 0,
    maxRestoreMs: 0,
    steps: 0,
    stepMs: 0,
    replayStepMs: 0,
    maxRollbackMs: 0,
  });
  globalThis.tm4LivePrediction = {
    retain_live_tick(tick) {
      const now = performance.now();
      const retained = engine._WebNetRetainLocalCheckpoint(tick);
      cost.captures++;
      cost.captureMs += performance.now() - now;
      return retained ? engine._WebNetLocalCheckpointStorageBytes() : 0;
    },
    restore_live_tick(tick) {
      const now = performance.now();
      const restored = engine._WebNetRestoreLocalTick(tick);
      const elapsed = performance.now() - now;
      cost.restores++;
      cost.restoreMs += elapsed;
      cost.maxRestoreMs = Math.max(cost.maxRestoreMs, elapsed);
      if (restored) replayStarted = now;
      return !!restored;
    },
    stage_live_input: (tick, slot, buttons, axes, analog) =>
      !!engine._WebNetSetInput(tick, slot, buttons, axes, +analog),
    step_live_tick(tick) {
      const now = performance.now();
      const stepped = engine._WebNetQueueTick(tick);
      cost.steps++;
      const elapsed = performance.now() - now;
      cost.stepMs += elapsed;
      if (replayStarted !== undefined) cost.replayStepMs += elapsed;
      return !!stepped;
    },
    live_digest_section: (index) =>
      (index === 0 ? port.netMatch?.digest : port.netMatch?.sections?.[index - 1]) ?? 0,
    set_live_presentation_phase: (phase, correction) =>
      engine._WebNetSetPresentationPhase(phase, correction),
    finish_live_replay() {
      const result = engine._WebNetFinishLocalReplay();
      if (replayStarted !== undefined)
        cost.maxRollbackMs = Math.max(cost.maxRollbackMs, performance.now() - replayStarted);
      replayStarted = undefined;
      return result;
    },
  };
  return {
    depth: engine._WebNetLocalRollbackDepth(),
    confirm: (tick: number) => engine._WebNetConfirmPresentationTick(tick),
    close() {
      globalThis.tm4LivePrediction = undefined;
    },
  };
}
