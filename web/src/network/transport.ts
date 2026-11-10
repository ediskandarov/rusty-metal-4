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
  const transport = {
    readyState: 0,
    diagnostics: () =>
      JSON.parse(client.diagnostics()) as {
        rttMs: number;
        jitterMs: number;
        queuedPackets: number;
        pendingInputs: number;
      },
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
    try {
      const messages = JSON.parse(client.update()) as unknown[];
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
