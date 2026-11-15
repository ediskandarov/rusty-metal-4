import { expect, test } from "bun:test";

import { shutdownContainer } from "../../apps/rustymetal4.com/src/worker/container-shutdown.ts";

function fixture() {
  const calls: string[] = [];
  const exit = Promise.withResolvers<void>();
  const container = {
    running: true,
    monitor() {
      calls.push("monitor");
      return exit.promise;
    },
    signal(signo: number) {
      calls.push(`signal:${signo}`);
    },
    destroy() {
      calls.push("destroy");
      container.running = false;
      exit.resolve();
      return Promise.resolve();
    },
  };
  return { container, calls, exit };
}

test("normal shutdown monitors before SIGTERM and never destroys the container", async () => {
  const { container, calls, exit } = fixture();
  const stopping = shutdownContainer(container, 1000);
  expect(calls).toEqual(["monitor", "signal:15"]);
  container.running = false;
  exit.resolve();
  await stopping;
  expect(calls).toEqual(["monitor", "signal:15"]);
});

test("an inactive container requires no shutdown operations", async () => {
  const { container, calls } = fixture();
  container.running = false;
  await shutdownContainer(container);
  expect(calls).toEqual([]);
});

test("a stuck process is destroyed after the shutdown deadline", async () => {
  const { container, calls } = fixture();
  await shutdownContainer(container, 5);
  expect(calls).toEqual(["monitor", "signal:15", "destroy"]);
});

test("an abnormal exit is observed without destroying an already stopped container", async () => {
  const { container, calls, exit } = fixture();
  const stopping = shutdownContainer(container, 1000);
  container.running = false;
  exit.reject(Object.assign(new Error("Process exited"), { exitCode: 1 }));
  await stopping;
  expect(calls).toEqual(["monitor", "signal:15"]);
});

test("failure to signal still cleans up the running container", async () => {
  const { container, calls } = fixture();
  container.signal = () => {
    throw new Error("Signal failed");
  };
  await shutdownContainer(container, 1000);
  expect(calls).toEqual(["monitor", "destroy"]);
});

test("failed forced cleanup propagates so capacity is not released prematurely", async () => {
  const { container, exit } = fixture();
  container.destroy = () => {
    exit.resolve();
    return Promise.reject(new Error("Destroy failed"));
  };
  await expect(shutdownContainer(container, 5)).rejects.toThrow("Destroy failed");
});
