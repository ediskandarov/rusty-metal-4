import { expect, test } from "bun:test";

import type { GameModule } from "@tm4/game-runtime/runtime/module";

import {
  createRenderingStore,
  effectiveRenderingSettings,
  simulationStepMs,
} from "../../apps/player/src/state/rendering.ts";
import { applyRenderingSettings } from "../../apps/player/src/ui/rendering.ts";

test("presets and manual choices have one source of truth", () => {
  const store = createRenderingStore();
  expect(store.getState().preset).toBe("ultra");
  expect(store.getState().settings.renderLimit).toBe(120);
  store.getState().selectPreset("ps1");
  expect(store.getState().settings).toEqual({
    scale: 1,
    carLodDistance: 1,
    drawDistance: 1,
    dithering: 0,
    renderLimit: 30,
    subpixelVertices: false,
    perspectiveTextures: false,
    smoothing: false,
    smoothingDelay: simulationStepMs,
  });
  store.getState().change({ scale: 3, smoothing: true, smoothingDelay: 10 });
  expect(store.getState().preset).toBe("custom");
  const selected = store.getState().settings;
  store.getState().selectPreset("custom");
  expect(store.getState().settings).toBe(selected);
  store.getState().change({ smoothing: false });
  store.getState().change({ smoothing: true });
  expect(store.getState().settings.smoothingDelay).toBe(10);
});

test("network constraints preserve offline choices across repeated notifications", () => {
  const store = createRenderingStore();
  store.getState().change({ renderLimit: 60, smoothingDelay: 15 });
  const selected = store.getState().settings;
  store.getState().setNetwork(true);
  store.getState().setNetwork(true);
  expect(effectiveRenderingSettings(store.getState())).toEqual({
    ...selected,
    renderLimit: 30,
    smoothing: false,
  });
  store.getState().change({ renderLimit: 120, smoothing: true, smoothingDelay: 0 });
  expect(store.getState().settings).toBe(selected);
  store.getState().setNetwork(false);
  expect(effectiveRenderingSettings(store.getState())).toBe(selected);
});

test("network presets alter visuals while restoring prior offline timing", () => {
  const store = createRenderingStore();
  store.getState().change({ renderLimit: 60, smoothingDelay: 5 });
  store.getState().setNetwork(true);
  store.getState().selectPreset("ps1");
  expect(store.getState().settings.scale).toBe(1);
  expect(effectiveRenderingSettings(store.getState()).renderLimit).toBe(30);
  store.getState().setNetwork(false);
  expect(store.getState().settings.renderLimit).toBe(60);
  expect(store.getState().settings.smoothing).toBe(true);
  expect(store.getState().settings.smoothingDelay).toBe(5);
  expect(store.getState().preset).toBe("custom");
});

test("reset disables graphs without bypassing the network restriction", () => {
  const store = createRenderingStore(true);
  store.getState().selectPreset("ps1");
  store.getState().setNetwork(true);
  store.getState().reset();
  expect(store.getState().showPerformance).toBe(false);
  expect(store.getState().settings.scale).toBe(8);
  expect(effectiveRenderingSettings(store.getState()).smoothing).toBe(false);
  store.getState().setNetwork(false);
  expect(store.getState().preset).toBe("custom");
  store.getState().reset();
  expect(store.getState().preset).toBe("ultra");
  expect(store.getState().settings.renderLimit).toBe(120);
  expect(store.getState().settings.smoothing).toBe(true);
});

test("unchanged effective settings do not reconfigure Wasm", () => {
  const calls: [string, number][] = [];
  const methods = [
    "_WebSetRenderScale",
    "_WebSetCarLodDistance",
    "_WebSetDrawDistance",
    "_WebSetRenderDithering",
    "_WebSetSubpixelVertices",
    "_WebSetPerspectiveTextures",
    "_WebSetRenderLimit",
    "_WebSetRenderSmoothingDelay",
    "_WebSetRenderSmoothing",
  ];
  const module = Object.fromEntries(
    methods.map((name) => [name, (value: number) => calls.push([name, value])]),
  ) as unknown as GameModule;
  const store = createRenderingStore();
  const initial = effectiveRenderingSettings(store.getState());
  applyRenderingSettings(module, initial);
  expect(calls).toHaveLength(9);
  calls.length = 0;
  store.getState().setShowPerformance(true);
  applyRenderingSettings(module, effectiveRenderingSettings(store.getState()), initial);
  expect(calls).toEqual([]);
  store.getState().setNetwork(true);
  applyRenderingSettings(module, effectiveRenderingSettings(store.getState()), initial);
  expect(calls).toEqual([
    ["_WebSetRenderLimit", 30],
    ["_WebSetRenderSmoothing", 0],
  ]);
});
