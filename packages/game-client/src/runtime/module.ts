import type { DiscAssets } from "@tm4/resources/loader/types";

import type { NetworkEngine } from "../network/protocol.ts";

export interface GameExports extends NetworkEngine {
  _WebSetAntialiasing(this: void, value: number): void;
  _WebSetRenderScale(this: void, value: number): void;
  _WebSetCarLodDistance(this: void, value: number): void;
  _WebSetDrawDistance(this: void, value: number): void;
  _WebSetRenderDithering(this: void, value: number): void;
  _WebSetRenderLimit(this: void, value: number): void;
  _WebSetSubpixelVertices(this: void, value: number): void;
  _WebSetPerspectiveTextures(this: void, value: number): void;
  _WebSetRenderSmoothing(this: void, enabled: number): void;
  _WebSetRenderSmoothingDelay(this: void, milliseconds: number): void;
  _WebGetPresentedFrames(this: void): number;
  _WebGetRenderedFrames(this: void): number;
  _WebGetSimulationSteps(this: void): number;
  _WebSetCheat(this: void, index: number, enabled: number): void;
  _WebGetCheats(this: void): number;
  _WebSetInputBlocked(this: void, value: number): void;
  _WebSetKeyboardButtons(this: void, value: number): void;
  _WebMapGamepadButton(this: void, slot: number, target: number, source: number): void;
  _WebGetInputDevice(this: void, player: number): number;
  _WebGetPhysicalButtons(this: void, player: number): number;
  _WebGetControlAction(this: void, player: number, action: number): number;
  _WebMusicConfigureTrack(
    this: void,
    number: number,
    start: number,
    end: number,
    toc: number,
  ): void;
  _WebMusicConfigureDisc(this: void, count: number, leadout: number): void;
}

export interface GameModule extends GameExports {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array<ArrayBuffer>, options?: { canOwn: boolean }): void;
  };
  callMain(args?: string[]): void;
}

export interface ModuleOptions {
  canvas: HTMLCanvasElement;
  tm4ResourceMods?: number;
  tm4LocalCheckpoint?: boolean;
  noInitialRun: boolean;
  print(text: string): void;
  printErr(text: string): void;
  setStatus(text: string): void;
  onRuntimeInitialized(): void;
  onAbort(reason: unknown): void;
}

export type PendingModule = ModuleOptions & Partial<GameModule>;

export function requireRuntime(
  module: PendingModule,
): asserts module is PendingModule & GameModule {
  if (
    !module.FS ||
    typeof module.callMain !== "function" ||
    typeof module._WebMusicConfigureTrack !== "function" ||
    typeof module._WebMusicConfigureDisc !== "function"
  ) {
    throw new Error("The WebAssembly runtime does not match the browser loader");
  }
}

declare global {
  var Module: PendingModule;
  var tm4Assets: Pick<DiscAssets, "readAudio" | "readMovie">;
}
