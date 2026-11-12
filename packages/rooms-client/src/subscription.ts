import { z } from "zod";
export function subscribe<T>(
  endpoint: URL,
  schema: z.ZodType<T>,
  event: (value: T) => void,
  status: (live: boolean) => void,
  recover: () => Promise<boolean>,
): () => void {
  let socket: WebSocket | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastPong = Date.now();
  const open = () => {
    if (stopped) return;
    const url = new URL(endpoint);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    socket.onopen = () => {
      lastPong = Date.now();
      status(true);
    };
    socket.onmessage = (message) => {
      if (stopped) return;
      lastPong = Date.now();
      if (message.data === "pong") return;
      try {
        event(schema.parse(JSON.parse(String(message.data))));
      } catch {
        socket?.close();
      }
    };
    socket.onclose = () => {
      if (stopped) return;
      status(false);
      retry = setTimeout(() => {
        void (async () => {
          try {
            if (!(await recover())) {
              close();
              return;
            }
          } catch {
            /* The next socket retries after an outage. */
          }
          if (!stopped) open();
        })();
      }, 2000);
    };
    socket.onerror = () => socket?.close();
  };
  const heartbeat = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > 50_000) socket.close();
    else socket.send("ping");
  }, 20_000);
  open();
  const close = () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(heartbeat);
    socket?.close();
  };
  return close;
}
