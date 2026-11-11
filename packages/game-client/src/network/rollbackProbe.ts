import type { Input, NetworkEngine } from "./protocol.ts";

interface Engine extends NetworkEngine {
  _WebNetRetainLocalCheckpoint(tick: number): number;
  _WebNetLocalCheckpointStorageBytes(): number;
  _WebNetLocalRollbackDepth(): number;
  _WebNetRestoreLocalTick(tick: number): number;
  _WebNetFinishLocalReplay(): number;
}

interface Driver {
  ready(): boolean;
  arm(depth: number): number;
  pump(advance: boolean, buttons: number, axes: number, analog: boolean): void;
  send_remote(endTick: number, buttons: Uint16Array<ArrayBuffer>): void;
  confirmed(): number | undefined;
  replayed(): number;
  close(): void;
  free(): void;
}

interface Observation {
  beforeStep?(tick: number): void;
  stepped?(tick: number, replaying: boolean, elapsedMs: number): void;
  captured?(tick: number, bytes: number, totalBytes: number, elapsedMs: number): void;
  restored?(tick: number, elapsedMs: number): void;
}

type Bridge = {
  retain(tick: number): boolean;
  restore(tick: number): boolean;
  step(
    tick: number,
    localButtons: number,
    localAxes: number,
    localAnalog: boolean,
    remoteButtons: number,
    remoteAxes: number,
    remoteAnalog: boolean,
    replaying: boolean,
  ): boolean;
  finish(): boolean;
};

declare global {
  var tm4Rollback: Bridge | undefined;
}

/** Borrow one initialized C instance. Rust invokes this bridge from Lightyear's schedules. */
export async function attachRollbackProbe(engine: Engine, endpoint: string, observer: Observation) {
  const path = new URL("network/tm4_network.js", document.baseURI).href;
  const bindings = (await import(path)) as {
    default(): Promise<unknown>;
    RollbackProbe: new (endpoint: string) => Driver;
  };
  await bindings.default();
  if (globalThis.tm4Rollback) throw new Error("A rollback probe already owns the C match");
  const driver = new bindings.RollbackProbe(endpoint);
  const depth = engine._WebNetLocalRollbackDepth();
  globalThis.tm4Rollback = {
    retain(tick) {
      const start = performance.now();
      const bytes = engine._WebNetRetainLocalCheckpoint(tick);
      const elapsed = performance.now() - start;
      if (bytes)
        observer.captured?.(tick, bytes, engine._WebNetLocalCheckpointStorageBytes(), elapsed);
      return !!bytes;
    },
    restore(tick) {
      const start = performance.now();
      const restored = engine._WebNetRestoreLocalTick(tick);
      if (restored) observer.restored?.(tick, performance.now() - start);
      return !!restored;
    },
    step(
      tick,
      localButtons,
      localAxes,
      localAnalog,
      remoteButtons,
      remoteAxes,
      remoteAnalog,
      replaying,
    ) {
      observer.beforeStep?.(tick);
      const start = performance.now();
      if (
        !engine._WebNetSetInput(tick, 0, localButtons, localAxes, +localAnalog) ||
        !engine._WebNetSetInput(tick, 1, remoteButtons, remoteAxes, +remoteAnalog) ||
        !engine._WebNetQueueTick(tick)
      )
        return false;
      observer.stepped?.(tick + 1, replaying, performance.now() - start);
      return true;
    },
    finish: () => !!engine._WebNetFinishLocalReplay(),
  };
  return {
    depth,
    ready: () => driver.ready(),
    arm: () => driver.arm(depth),
    pump: (advance: boolean, input?: Input) =>
      driver.pump(advance, input?.buttons ?? 0, input?.axes ?? 0, input?.analog ?? false),
    sendRemote: (endTick: number, buttons: number[]) =>
      driver.send_remote(endTick, Uint16Array.from(buttons)),
    confirmed: () => driver.confirmed(),
    replayed: () => driver.replayed(),
    close() {
      try {
        driver.close();
        driver.free();
      } finally {
        globalThis.tm4Rollback = undefined;
      }
    },
  };
}
