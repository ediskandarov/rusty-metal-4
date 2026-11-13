import { expect, test } from "bun:test";

import {
  canSelectDisc,
  createStartupStore,
  runtimeWasStarted,
} from "../../apps/player/src/state/startup.ts";

test("browser support gates disc selection and cannot be bypassed by starting again", () => {
  const store = createStartupStore();
  const actions = store.getState();
  expect(canSelectDisc(store.getState().phase)).toBe(false);
  expect(actions.begin("folder")).toBe(false);
  actions.fail(new Error("HTTPS required"));
  actions.browserReady();
  expect(store.getState().phase).toEqual({
    kind: "failed",
    source: "browser",
    message: "HTTPS required",
  });
  expect(actions.begin("folder")).toBe(false);
});

test("one launch owns the player until completion, including remote disc discovery", () => {
  const store = createStartupStore();
  const actions = store.getState();
  actions.browserReady();
  expect(actions.begin("dev-server")).toBe(true);
  expect(actions.begin("folder")).toBe(false);
  actions.loadDisc(["Optional audio unavailable"]);
  actions.reportProgress("Reading MAIN.MR");
  actions.warn("Texture palette differs");
  actions.prepareMods();
  expect(actions.begin("folder")).toBe(false);
  actions.startRuntime();
  expect(runtimeWasStarted(store.getState().phase)).toBe(true);
  expect(actions.begin("folder")).toBe(false);
  actions.complete();
  expect(store.getState().phase.kind).toBe("running");
  expect(store.getState().warnings).toEqual([
    "Optional audio unavailable",
    "Texture palette differs",
  ]);
  expect(actions.begin("folder")).toBe(false);
  expect(canSelectDisc(store.getState().phase)).toBe(false);
});

test("a failed disc can be replaced without retaining its errors or warnings", () => {
  const store = createStartupStore();
  const actions = store.getState();
  actions.browserReady();
  actions.begin("folder");
  actions.warn("Old disc warning");
  actions.fail(new Error("Missing MAIN.MR"));
  expect(canSelectDisc(store.getState().phase)).toBe(true);
  expect(runtimeWasStarted(store.getState().phase)).toBe(false);
  actions.reportProgress("Stale progress");
  expect(store.getState().phase).toEqual({
    kind: "failed",
    source: "disc",
    message: "Missing MAIN.MR",
  });
  expect(actions.begin("folder")).toBe(true);
  expect(store.getState().warnings).toEqual([]);
  expect(store.getState().phase.kind).toBe("loading-disc");
});

test("missing dev server leaves manual disc selection available", () => {
  const store = createStartupStore();
  const actions = store.getState();
  actions.browserReady();
  actions.begin("dev-server");
  actions.fail("Local disc unavailable");
  expect(canSelectDisc(store.getState().phase)).toBe(true);
  expect(actions.begin("folder")).toBe(true);
});

test("mod installation can be retried but partial Wasm startup requires a reload", () => {
  const store = createStartupStore();
  const actions = store.getState();
  actions.browserReady();
  actions.begin("folder");
  actions.prepareMods();
  actions.fail("Invalid mod");
  expect(actions.begin("folder")).toBe(true);
  actions.prepareMods();
  actions.startRuntime();
  actions.fail("Could not load the game runtime");
  expect(store.getState().phase).toEqual({
    kind: "failed",
    source: "runtime",
    message: "Could not load the game runtime",
  });
  expect(runtimeWasStarted(store.getState().phase)).toBe(true);
  expect(canSelectDisc(store.getState().phase)).toBe(false);
  expect(actions.begin("folder")).toBe(false);
  actions.complete();
  expect(store.getState().phase.kind).toBe("failed");
});

test("progress callbacks do not reopen the startup UI after the game starts", () => {
  const store = createStartupStore();
  const actions = store.getState();
  actions.browserReady();
  actions.begin("folder");
  actions.prepareMods();
  actions.startRuntime();
  actions.complete();
  const state = store.getState();
  actions.reportProgress("Late load callback");
  actions.warn("Late warning");
  actions.fail("Late startup failure");
  expect(store.getState()).toBe(state);
});
