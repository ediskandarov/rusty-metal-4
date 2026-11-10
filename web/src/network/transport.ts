import { configureMatch } from "./protocol.ts";
/** Rust owns Lightyear's connection, channels, serialization, and network timelines.
 * The Emscripten game is a separate Wasm instance. This bridge copies JSON values
 * only at the JS/Rust boundary; the wire uses Lightyear's typed binary protocol.
 */
interface RustClient {
  connected(): boolean;
  send(json: string): number | undefined;
  update(): string;
  diagnostics(): string;
  prepare_prediction(players: number): void;
  prediction_clock(): number;
  begin_prediction(
    anchor: number,
    epoch: number,
    players: number,
    slot: number,
    depth: number,
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
      ...(JSON.parse(client.diagnostics()) as {
        rttMs: number;
        jitterMs: number;
        queuedPackets: number;
        pendingInputs: number;
        nativeTick: number;
        prediction: {
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
      }),
      pump: { pollGapMs, maxPollGapMs, maxUpdateMs, visibility: document.visibilityState },
    }),
    preparePrediction: (players: number) => client.prepare_prediction(players),
    predictionClock: () => client.prediction_clock(),
    beginPrediction: (
      anchor: number,
      epoch: number,
      players: number,
      slot: number,
      depth: number,
    ) => {
      client.begin_prediction(anchor, epoch, players, slot, depth);
      lastPoll = performance.now();
      maxPollGapMs = maxUpdateMs = 0;
    },
    predictionInput: (buttons: number, axes: number, analog: boolean) =>
      client.prediction_input(buttons, axes, analog),
    condition: (latency: number, jitter: number) => client.condition(latency, jitter),
    onopen: (() => {}) as () => void,
    onmessage: ((_message: unknown) => {}) as (message: unknown) => void,
    onerror: ((_error: unknown) => {}) as (error: unknown) => void,
    send(message: object) {
      if (closed || !opened) throw new Error("Lightyear connection is not open");
      return client.send(JSON.stringify(message));
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
    const now = performance.now();
    pollGapMs = now - lastPoll;
    maxPollGapMs = Math.max(maxPollGapMs, pollGapMs);
    lastPoll = now;
    try {
      const messages = JSON.parse(client.update()) as unknown[];
      maxUpdateMs = Math.max(maxUpdateMs, performance.now() - now);
      const connected = client.connected();
      if (!opened && connected) {
        opened = true;
        transport.readyState = 1;
        transport.onopen();
      } else if (opened && !connected) {
        throw new Error("Lost the Lightyear connection");
      } else if (!opened && performance.now() - started > 10_000) {
        throw new Error("Lightyear connection timed out");
      }
      for (const message of messages) transport.onmessage(message);
    } catch (error) {
      maxUpdateMs = Math.max(maxUpdateMs, performance.now() - now);
      console.error("Lightyear runtime failure", error);
      transport.onerror(error);
      transport.close();
    }
  }, 5);
  return transport;
}

declare global {
  var tm4Network: { connect: typeof connectNetwork; configure: typeof configureMatch };
}
globalThis.tm4Network = { connect: connectNetwork, configure: configureMatch };
