import type { Page } from "playwright";
import { chromium } from "playwright";

import type {
  configureMatch,
  NetworkEngine,
  NetworkPort,
  Start,
  Step,
} from "../../web/src/network/protocol.ts";
import type { connectNetwork } from "../../web/src/network/transport.ts";

type ServerMessage =
  | Start
  | Step
  | { type: "welcome"; slot: null }
  | { type: "finished" }
  | { type: "error"; message: string };

type AuthorityPage = typeof globalThis & {
  Module: NetworkEngine;
  tm4Port: NetworkPort;
  tm4Network: { connect: typeof connectNetwork; configure: typeof configureMatch };
};

export async function connectAuthority(page: Page, endpoint: string, token: string) {
  await page.evaluate(
    async ({ endpoint, token }) => {
      const socket = await (globalThis as AuthorityPage).tm4Network.connect(endpoint);
      return new Promise<void>((resolve, reject) => {
        const { Module: engine, tm4Port: port } = globalThis as AuthorityPage;
        const send = (message: object) => socket.send(message);
        socket.onopen = () =>
          send({
            type: "authority",
            token,
            compatibility: port.compatibility,
            catalog: port.catalog,
          });
        const cleanup = () => {
          delete port.netMatchTick;
          socket.close();
          queueMicrotask(() => engine._WebNetCancelMatch());
        };
        socket.onerror = (error) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        };

        port.netMatchTick = () => {
          const state = port.netMatch;
          if (!state) return;
          send({ type: "completed", tick: state.tick - 1, state });
        };
        socket.onmessage = (data: unknown) => {
          try {
            const message = data as ServerMessage;
            switch (message.type) {
              case "welcome":
                console.log("Server simulator connected");
                break;
              case "start": {
                if (!(globalThis as AuthorityPage).tm4Network.configure(engine, message, -1))
                  throw new Error("The game refused the match setup");
                if (!port.netMatch)
                  throw new Error("The simulator did not become ready at tick zero");
                send({ type: "ready", epoch: message.epoch, digest: port.netMatch?.digest });
                break;
              }
              case "step":
                for (const [slot, input] of message.inputs.entries()) {
                  if (
                    !engine._WebNetSetInput(
                      message.tick,
                      slot,
                      input.buttons,
                      input.axes,
                      +input.analog,
                    )
                  )
                    throw new Error("The game refused input for tick " + message.tick);
                }
                if (!engine._WebNetQueueTick(message.tick))
                  throw new Error("The game refused to run tick " + message.tick);
                break;
              case "finished":
                cleanup();
                resolve();
                break;
              case "error":
                throw new Error(message.message);
            }
          } catch (error) {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
      });
    },
    { endpoint, token },
  );
}

if (import.meta.main) {
  const token = process.env.TM4_AUTHORITY_TOKEN;
  if (!token) throw new Error("Set TM4_AUTHORITY_TOKEN to the server's authority token");
  const endpoint = process.env.TM4_MATCH_ENDPOINT ?? "ws://127.0.0.1:8122";
  const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:8120";

  const browser = await chromium.launch({
    executablePath: process.env.TM4_CHROME,
    channel: process.env.TM4_CHROME ? undefined : "chrome",
    args: [
      "--enable-unsafe-swiftshader",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" || /Match cars|initialized/.test(message.text()))
        console.error(message.text());
    });
    const url = new URL(site);
    url.searchParams.set("authority", "1");
    await page.goto(url.href);
    await page.waitForFunction(() => (globalThis as AuthorityPage).tm4Port?.compatibility);

    await connectAuthority(page, endpoint, token);
  } finally {
    await browser.close();
  }
}
