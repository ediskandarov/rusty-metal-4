import assert from "node:assert/strict";

import { networkProtocolVersion } from "@tm4/lightyear-client/schemas";

import { eventually, runtime } from "../rooms/runtime.ts";
import { launchBrowser } from "./helpers/browser.mjs";

// Exercise the actual room UI/API with a small player boundary, without loading disc assets.
const mf = await runtime(true);
let browser;
const compatibility = {
  protocol: networkProtocolVersion,
  build: "a".repeat(64),
  content: "b".repeat(64),
};
try {
  const origin = (await mf.ready).origin;
  browser = await launchBrowser();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const errors = [];
  for (const context of contexts) {
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    await context.route("**/play/simulation-build.json", (route) =>
      route.fulfill({ json: { sha256: "a".repeat(64) } }),
    );
    await context.route("**/play/?room=*", (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: { "Cross-Origin-Embedder-Policy": "require-corp" },
        body: `<script>
          window.commands = [];
          addEventListener('message', ({data}) => {
            window.commands.push(data);
            if (data.action === 'status') parent.postMessage({
              type: 'rm4-player', roomId: data.roomId, status: data.message
            }, location.origin);
          });
        </script>`,
      }),
    );
  }
  const [host, guest] = await Promise.all(contexts.map((context) => context.newPage()));
  await host.goto(origin);
  await host.locator("#create-player").fill("Host");
  await host.locator("#create-name").fill("Controls");
  await host.locator("#create-form button").click();
  await host.waitForURL(/\/rooms\/[a-f0-9]{32}$/);
  const invite = host.url();
  const id = new URL(invite).pathname.split("/").pop();
  const view = async () =>
    (await (await contexts[0].request.get(`${origin}/api/rooms/${id}`)).json()).room;
  const post = async (path, data = {}) => {
    const response = await contexts[0].request.post(`${origin}/api/rooms/${id}/${path}`, {
      headers: { Origin: origin },
      data,
    });
    assert(response.ok(), await response.text());
    return response;
  };
  const player = async (page) => {
    await page.locator("#room-player").waitFor();
    const frame = await (await page.locator("#room-player").elementHandle()).contentFrame();
    await frame.waitForFunction(() => Array.isArray(window.commands));
    return frame;
  };
  const loaded = async (frame) => {
    await frame.evaluate(
      ({ id, compatibility }) =>
        parent.postMessage(
          {
            type: "rm4-player",
            roomId: id,
            loaded: true,
            compatibility,
            cars: ["Orbital", "Pizza Boy"],
          },
          location.origin,
        ),
      { id, compatibility },
    );
  };
  const hostPlayer = await player(host);
  await loaded(hostPlayer);
  await eventually(view, (room) => room.participants[0]?.car === "Orbital");
  await host.waitForFunction(() => !document.getElementById("room-car").disabled);

  let release;
  let intercepted;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  await host.route(
    `**/api/rooms/${id}/player`,
    async (route) => {
      intercepted();
      await held;
      await route.continue();
    },
    { times: 1 },
  );
  await host.locator("#room-car").selectOption("Pizza Boy");
  await seen;
  assert(await host.locator("#room-car").isDisabled());
  assert(await host.locator("#prepare-match").isDisabled());
  await host.locator("#edit-name").fill("Unsaved name");
  await guest.goto(invite);
  await guest.locator("#join-player").fill("Guest");
  await guest.locator("#join-form button").click();
  await host.getByText("Guest", { exact: true }).waitFor();
  assert.equal(await host.locator("#room-car").inputValue(), "Pizza Boy");
  assert.equal(await host.locator("#edit-name").inputValue(), "Unsaved name");
  release();
  await eventually(view, (room) => room.participants[0]?.car === "Pizza Boy");
  await host.waitForFunction(() => !document.getElementById("room-car").disabled);

  await host.route(
    `**/api/rooms/${id}/player`,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Car selection temporarily unavailable" },
      }),
    { times: 1 },
  );
  await host.locator("#room-car").selectOption("Orbital");
  await host
    .locator("#player-status")
    .filter({ hasText: "Car selection temporarily unavailable" })
    .waitFor();
  assert.equal(await host.locator("#room-car").inputValue(), "Pizza Boy");
  const guestPlayer = await player(guest);
  await loaded(guestPlayer);
  await eventually(view, (room) => room.participants[1]?.car === "Orbital");
  assert.equal(
    await host.locator("#player-status").textContent(),
    "Car selection temporarily unavailable",
  );
  assert.equal(
    await hostPlayer.evaluate(
      () => window.commands.filter((command) => command.action === "status").length,
    ),
    1,
    "echoed player status must not cause a postMessage feedback loop",
  );
  await host.locator("#room-car").selectOption("Orbital");
  await eventually(view, (room) => room.participants[0]?.car === "Orbital");
  await host.waitForFunction(() => !document.getElementById("room-car").disabled);
  await host.locator("#settings-form button").click();
  await host.getByText("Settings saved for everyone.", { exact: true }).waitFor();
  assert.equal(await host.locator("#room-name").textContent(), "Unsaved name");
  console.log(
    "PASS pending car and settings drafts survive live updates; rejected selection restores authority without losing the error",
  );

  await host.locator("#prepare-match").click();
  await hostPlayer.waitForFunction(() =>
    window.commands.some((command) => command.action === "upload"),
  );
  let match = (await view()).match;
  assert(match);
  await host.locator("#cancel-preparation").click();
  await eventually(view, (room) => !room.match);
  await host.waitForFunction(() => !document.getElementById("prepare-match").disabled);
  await host.locator("#prepare-match").click();
  await hostPlayer.waitForFunction(
    () => window.commands.filter((command) => command.action === "upload").length === 2,
  );
  match = (await view()).match;
  await post(`match/${match.id}/prepare`);
  await eventually(view, (room) => room.match?.stage === "ready");
  for (const page of [host, guest]) {
    await page.waitForFunction(() => !document.getElementById("room-ready").disabled);
    await page.locator("#room-ready").click();
  }
  await host.waitForFunction(() => !document.getElementById("start-match").disabled);
  await host.locator("#start-match").click();
  for (const frame of [hostPlayer, guestPlayer])
    await frame.waitForFunction(
      () => window.commands.filter((command) => command.action === "join").length === 1,
    );
  await host.locator("#reconnect-match").click();
  await hostPlayer.waitForFunction(
    () => window.commands.filter((command) => command.action === "join").length === 2,
  );
  assert.equal(
    await hostPlayer.evaluate(
      () => window.commands.filter((command) => command.action === "stop").length,
    ),
    1,
  );
  const download = host.waitForEvent("download");
  await host.locator("#download-server-journal").click();
  assert.equal((await download).suggestedFilename(), `rustymetal4-server-${match.id}.tm4j`);
  await host.getByText("Journal saved through", { exact: false }).waitFor();
  console.log(
    "PASS prepare/cancel/ready/start/reconnect and journal controls share the same room snapshot",
  );
  await guest.locator("#leave-button").click();
  await guest.waitForURL(origin + "/");
  await host.locator("#leave-button").click();
  await host.waitForURL(origin + "/");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await mf.dispose();
}
