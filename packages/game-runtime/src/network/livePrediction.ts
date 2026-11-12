import { journalAuthorityFrameSchema } from "@tm4/lightyear-client/schemas";

import type { ClientJournal } from "./journal.ts";
import type { NetworkEngine, NetworkPort } from "./protocol.ts";

interface PredictionEngine extends NetworkEngine {
  _WebNetEnableRenderedPrediction(): number;
  _WebNetRetainLocalCheckpoint(tick: number): number;
  _WebNetLocalCheckpointStorageBytes(): number;
  _WebNetLocalRollbackDepth(): number;
  _WebNetRestoreLocalTick(tick: number): number;
  _WebNetFinishLocalReplay(): number;
  _WebNetConfirmPresentationTick(tick: number): number;
}

interface Bridge {
  journal_authority_frame(json: string): void;
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
  finish_live_replay(): boolean;
}

declare global {
  var tm4LivePrediction: Bridge | undefined;
}

export function attachLivePrediction(
  runtime: NetworkEngine,
  port: NetworkPort,
  journal?: ClientJournal,
) {
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
    journal_authority_frame(json) {
      if (!journal) return;
      try {
        const { frame } = journalAuthorityFrameSchema.parse(JSON.parse(json));
        journal.record("authority", frame.tick + 1, { type: "frame", ...frame });
      } catch (error) {
        journal.record("journal-error", port.netMatch?.tick ?? null, {
          source: "authority",
          message: String(error),
        });
      }
    },
    retain_live_tick(tick) {
      const now = performance.now();
      const retained = engine._WebNetRetainLocalCheckpoint(tick);
      if (!retained) journal?.record("capture-rejected", tick, { state: port.netMatch });
      cost.captures++;
      cost.captureMs += performance.now() - now;
      return retained ? engine._WebNetLocalCheckpointStorageBytes() : 0;
    },
    restore_live_tick(tick) {
      const now = performance.now();
      const from = port.netMatch?.tick;
      const restored = engine._WebNetRestoreLocalTick(tick);
      const elapsed = performance.now() - now;
      cost.restores++;
      cost.restoreMs += elapsed;
      cost.maxRestoreMs = Math.max(cost.maxRestoreMs, elapsed);
      journal?.record("restore", tick, { restored: !!restored, from });
      if (restored) replayStarted = now;
      return !!restored;
    },
    stage_live_input(tick, slot, buttons, axes, analog) {
      const accepted = !!engine._WebNetSetInput(tick, slot, buttons, axes, +analog);
      journal?.record("input", tick + 1, { slot, buttons, axes, analog, accepted });
      return accepted;
    },
    step_live_tick(tick) {
      const now = performance.now();
      const stepped = engine._WebNetQueueTick(tick);
      cost.steps++;
      const elapsed = performance.now() - now;
      cost.stepMs += elapsed;
      if (replayStarted !== undefined) cost.replayStepMs += elapsed;
      journal?.record("step", tick + 1, {
        stepped: !!stepped,
        replay: replayStarted !== undefined,
        state: port.netMatch,
      });
      return !!stepped;
    },
    live_digest_section: (index) =>
      (index === 0 ? port.netMatch?.digest : port.netMatch?.sections?.[index - 1]) ?? 0,
    finish_live_replay() {
      const result = engine._WebNetFinishLocalReplay();
      if (replayStarted !== undefined)
        cost.maxRollbackMs = Math.max(cost.maxRollbackMs, performance.now() - replayStarted);
      journal?.record("replay-finished", port.netMatch?.tick ?? null, { success: !!result });
      replayStarted = undefined;
      return !!result;
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
