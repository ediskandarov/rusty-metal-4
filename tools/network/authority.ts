import { createRequire } from "node:module";

import type { Page } from "playwright";
import { chromium } from "playwright";

import type { NetworkEngine, NetworkPort, Start, Step } from "../../web/src/network/protocol.ts";

type ServerMessage =
  | Start
  | Step
  | { type: "welcome"; slot: null }
  | { type: "finished" }
  | { type: "error"; message: string };

type AuthorityPage = typeof globalThis & { Module: NetworkEngine; tm4Port: NetworkPort };

export async function connectAuthority(page: Page, endpoint: string, token: string) {
  await page.evaluate(
    ({ endpoint, token }) =>
      new Promise<void>((resolve, reject) => {
        const { Module: engine, tm4Port: port } = globalThis as AuthorityPage;
        const socket = new WebSocket(endpoint);
        socket.binaryType = "arraybuffer";
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const send = (message: object) => socket.send(encoder.encode(JSON.stringify(message)));
        socket.onopen = () => send({ type: "authority", token });
        socket.onerror = () => reject(new Error("The authority could not connect to Lightyear"));
        socket.onclose = () => reject(new Error("Lightyear closed the authority connection"));
        port.netMatchTick = () => {
          const state = port.netMatch;
          if (!state) return;
          send({ type: "completed", tick: state.tick - 1, state });
        };
        socket.onmessage = async ({ data }: MessageEvent<ArrayBuffer>) => {
          try {
            const message = JSON.parse(decoder.decode(data)) as ServerMessage;
            switch (message.type) {
              case "welcome":
                console.log("Server simulator connected");
                break;
              case "start": {
                if (!engine._WebNetRequestMatch(message.players, message.world, message.seed, -1))
                  throw new Error("The game refused the match setup");
                const deadline = performance.now() + 30_000;
                while (!port.netMatch) {
                  if (performance.now() >= deadline) throw new Error("Match loading timed out");
                  await new Promise(requestAnimationFrame);
                }
                send({ type: "ready" });
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
                resolve();
                break;
              case "error":
                throw new Error(message.message);
            }
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
      }),
    { endpoint, token },
  );
}

if (import.meta.main) {
  const token = process.env.TM4_AUTHORITY_TOKEN;
  if (!token) throw new Error("Set TM4_AUTHORITY_TOKEN to the server's authority token");
  const endpoint = process.env.TM4_MATCH_ENDPOINT ?? "ws://127.0.0.1:8122";
  const site = process.env.TM4_WEB_URL ?? "http://127.0.0.1:8120";
  const startup = createRequire(import.meta.url)("../../tests/browser/browser_startup.cjs") as (
    page: import("playwright").Page,
  ) => Promise<void>;

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
    await page.goto(site);
    await startup(page);

    await connectAuthority(page, endpoint, token);
  } finally {
    await browser.close();
  }
}
