import { z } from "zod";

import {
  buildManifestSchema,
  diagnosticsSchema,
  type Message,
  messageSchema,
  type Request,
  requestSchema,
} from "./schemas.ts";
/** Rust owns Lightyear's connection, channels, serialization, and network timelines.
 * The Emscripten game is a separate Wasm instance. This bridge copies JSON values
 * only at the JS/Rust boundary; the wire uses Lightyear's typed binary protocol.
 */
interface RustClient {
  connected(): boolean;
  send(json: string): void;
  update(): string;
  diagnostics(): string;
  prepare_prediction(
    slotMask: number,
    participants: string,
    preparedPool: string,
    resuming: boolean,
  ): void;
  prediction_clock(): number;
  begin_prediction(
    anchor: number,
    epoch: number,
    capacity: number,
    slot: number,
    depth: number,
  ): void;
  prediction_is_ready(): boolean;
  resume_target(anchor: number, head: number): number;
  begin_resumed_prediction(
    anchor: number,
    epoch: number,
    capacity: number,
    slot: number,
    depth: number,
    head: number,
    sequence: number,
  ): void;
  prediction_input(buttons: number, axes: number, analog: boolean): void;
  condition(latency: number, jitter: number): void;
  free(): void;
}
interface Bindings {
  default(): Promise<unknown>;
  NetworkClient: new (endpoint: string) => RustClient;
}
let bindings: Promise<Bindings> | undefined;

export class NetworkConnectionError extends Error {}

async function loadBindings(): Promise<Bindings> {
  if (!bindings)
    bindings = (async () => {
      const path = new URL("network/tm4_network.js", document.baseURI).href;
      const module = (await import(path)) as Bindings;
      await module.default();
      return module;
    })();
  return bindings;
}

export async function connectNetwork(endpoint: string) {
  const { NetworkClient } = await loadBindings();
  const client = new NetworkClient(endpoint);
  let closed = false;
  let opened = false;
  const started = performance.now();
  let lastPoll = started;
  let pollGapMs = 0;
  let maxPollGapMs = 0;
  let maxUpdateMs = 0;
  const transport = {
    readyState: 0,
    diagnostics: () => ({
      ...diagnosticsSchema.parse(JSON.parse(client.diagnostics())),
      pump: { pollGapMs, maxPollGapMs, maxUpdateMs, visibility: document.visibilityState },
    }),
    preparePrediction: (
      slotMask: number,
      participants: string[],
      preparedPool: string[],
      resuming: boolean,
    ) =>
      client.prepare_prediction(
        slotMask,
        JSON.stringify(participants),
        JSON.stringify(preparedPool),
        resuming,
      ),
    predictionClock: () => client.prediction_clock(),
    beginPrediction: (
      anchor: number,
      epoch: number,
      capacity: number,
      slot: number,
      depth: number,
    ) => {
      client.begin_prediction(anchor, epoch, capacity, slot, depth);
      lastPoll = performance.now();
      maxPollGapMs = maxUpdateMs = 0;
    },
    predictionIsReady: () => client.prediction_is_ready(),
    resumeTarget: (anchor: number, head: number) => client.resume_target(anchor, head),
    beginResumedPrediction: (
      anchor: number,
      epoch: number,
      capacity: number,
      slot: number,
      depth: number,
      head: number,
      sequence: number,
    ) => {
      client.begin_resumed_prediction(anchor, epoch, capacity, slot, depth, head, sequence);
      lastPoll = performance.now();
      maxPollGapMs = maxUpdateMs = 0;
    },
    predictionInput: (buttons: number, axes: number, analog: boolean) =>
      client.prediction_input(buttons, axes, analog),
    condition: (latency: number, jitter: number) => client.condition(latency, jitter),
    onopen: (() => {}) as () => void,
    onmessage: ((_message: Message) => {}) as (message: Message) => void,
    onerror: ((_error: unknown) => {}) as (error: unknown) => void,
    // Give the game a chance to replace an expired prediction timeline before Rust advances it.
    beforeUpdate: ((_gapMs: number) => true) as (gapMs: number) => boolean,
    send(message: Request) {
      if (closed || !opened) throw new Error("Lightyear connection is not open");
      return client.send(JSON.stringify(requestSchema.parse(message)));
    },
    close() {
      if (closed) return;
      closed = true;
      transport.readyState = 3;
      clearInterval(timer);
      try {
        client.free();
      } catch {
        /* A trapped Wasm instance cannot be reused. */
      }
    },
  };
  const timer = setInterval(() => {
    if (closed) return;
    const now = performance.now();
    pollGapMs = now - lastPoll;
    maxPollGapMs = Math.max(maxPollGapMs, pollGapMs);
    lastPoll = now;
    try {
      if (!transport.beforeUpdate(pollGapMs) || closed) return;
      const messages = z.array(messageSchema).parse(JSON.parse(client.update()));
      maxUpdateMs = Math.max(maxUpdateMs, performance.now() - now);
      const connected = client.connected();
      if (!opened && connected) {
        opened = true;
        transport.readyState = 1;
        transport.onopen();
      }
      for (const message of messages) {
        if (closed) break;
        transport.onmessage(message);
      }
      if (closed) return;
      if (opened && !connected) throw new NetworkConnectionError("Lost the Lightyear connection");
      if (!opened && performance.now() - started > 10_000)
        throw new NetworkConnectionError("Lightyear connection timed out");
    } catch (error) {
      maxUpdateMs = Math.max(maxUpdateMs, performance.now() - now);
      console.error("Lightyear runtime failure", error);
      transport.onerror(error);
      transport.close();
    }
  }, 5);
  return transport;
}

export async function getBuildManifest(url: string | URL, signal?: AbortSignal) {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error("Game build manifest: HTTP " + response.status);
  return buildManifestSchema.parse(await response.json());
}

export type NetworkDiagnostics = ReturnType<
  Awaited<ReturnType<typeof connectNetwork>>["diagnostics"]
>;
