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
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  const errors = [];
  for (const context of contexts) {
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    await context.route("**/play/simulation-build.json", (route) =>
      route.fulfill({
        json: {
          sha256: compatibility.build,
          authoritySha256: "c".repeat(64),
          modules: [
            {
              name: "o_car.wasm",
              sha256: "d".repeat(64),
              authoritySha256: "e".repeat(64),
            },
          ],
        },
      }),
    );
    await context.route("**/play/?room=*", (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: { "Cross-Origin-Embedder-Policy": "require-corp" },
        body: `<script>
          window.commands = [];
          addEventListener('message', ({data}) => {
            window.commands.push(data);
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
  await host.locator("#server-region").filter({ hasText: "Not allocated" }).waitFor();
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
            event: "loaded",
            compatibility,
            cars: ["Orbital", "Pizza Boy"],
          },
          location.origin,
        ),
      { id, compatibility },
    );
  };
  const choose = async (page, car) => {
    const frame = await player(page);
    await frame.waitForFunction(() =>
      window.commands.some((c) => c.action === "car-selection" && c.enabled),
    );
    await frame.evaluate(
      ({ id, car }) => {
        const command = window.commands.findLast((c) => c.action === "car-selection" && c.enabled);
        parent.postMessage(
          {
            type: "rm4-player",
            roomId: id,
            event: "car-selection",
            requestId: command.requestId,
            car,
          },
          location.origin,
        );
      },
      { id, car },
    );
  };
  const hostPlayer = await player(host);
  await loaded(hostPlayer);
  await eventually(view, (room) => room.participants[0]?.loaded);
  assert.equal((await view()).participants[0].car, null);
  assert.equal(await host.locator("#room-car, #room-ready").count(), 0);

  await host.locator("#edit-bots").selectOption(["Orbital", "Pizza Boy"]);
  await host.locator("#edit-human-limit").fill("4");
  await host.locator("#settings-form button[type=submit]").click();
  await eventually(view, (room) => room.modeOptions?.ffa.bots.length === 2);
  await host.locator("#participants .participant-role").filter({ hasText: "AI" }).first().waitFor();
  assert.equal(
    await host.locator("#participants .participant-role").filter({ hasText: "AI" }).count(),
    2,
  );
  assert.equal((await view()).freePlaces, 3);
  assert.equal((await view()).modeOptions.ffa.humanLimit, 4);
  await host.locator("#edit-bots").selectOption([]);
  await host.locator("#settings-form button[type=submit]").click();
  await eventually(view, (room) => room.modeOptions?.ffa.bots.length === 0);
  console.log("PASS FFA mode settings persist explicit bots and reserve shared room places");

  // Only this frame, this room and a complete resource event may change disc state.
  await host.evaluate(
    (id) =>
      window.postMessage(
        {
          type: "rm4-player",
          roomId: id,
          event: "unloaded",
        },
        location.origin,
      ),
    id,
  );
  await hostPlayer.evaluate((id) => {
    for (const message of [
      null,
      { type: "rm4-player", roomId: id, event: "loaded", cars: {} },
      { type: "rm4-player", roomId: id, event: "loaded", cars: ["Fake"] },
      { type: "rm4-player", roomId: "0".repeat(32), event: "unloaded" },
      { type: "rm4-player", roomId: id, loaded: false },
    ])
      parent.postMessage(message, location.origin);
    parent.postMessage(
      {
        type: "rm4-player",
        roomId: id,
        event: "status",
        sessionId: null,
        message: "Boundary checked",
      },
      location.origin,
    );
  }, id);
  await host.locator("#player-status").filter({ hasText: "Choose your car" }).waitFor();
  assert((await view()).participants[0].loaded);
  console.log(
    "PASS malformed, old-shape and unrelated player messages cannot change the room's loaded disc",
  );

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
  await choose(host, "Pizza Boy");
  await seen;
  await host.locator("#player-status").filter({ hasText: "Confirming your choice" }).waitFor();
  assert(await host.locator("#prepare-match").isDisabled());
  await host.locator("#edit-name").fill("Unsaved name");
  await guest.goto(invite);
  await guest.locator("#join-player").fill("Guest");
  await guest.locator("#join-form button").click();
  await host.getByText("Guest", { exact: true }).waitFor();
  assert.equal((await view()).participants[0].car, null);
  assert.equal(await host.locator("#edit-name").inputValue(), "Unsaved name");
  release();
  await eventually(view, (room) => room.participants[0]?.car === "Pizza Boy");
  await eventually(view, (room) => room.participants[0]?.ready);

  await host.route(
    `**/api/rooms/${id}/player`,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Car selection temporarily unavailable" },
      }),
    { times: 1 },
  );
  await choose(host, "Orbital");
  await host
    .locator("#player-status")
    .filter({ hasText: "Car selection temporarily unavailable" })
    .waitFor();
  assert.equal((await view()).participants[0].car, "Pizza Boy");
  const guestPlayer = await player(guest);
  await loaded(guestPlayer);
  await eventually(view, (room) => room.participants[1]?.loaded);
  assert.match(
    await host.locator("#player-status").textContent(),
    /Car selection temporarily unavailable/,
  );
  assert.equal(
    await hostPlayer.evaluate(
      () => window.commands.filter((command) => command.action === "status").length,
    ),
    0,
    "server preparation status must stay in the room",
  );
  await choose(host, "Orbital");
  await eventually(view, (room) => room.participants[0]?.car === "Orbital");
  await eventually(view, (room) => room.participants[0]?.ready);
  await host.locator("#settings-form button").click();
  await host.getByText("Settings saved for everyone.", { exact: true }).waitFor();
  assert.equal(await host.locator("#room-name").textContent(), "Unsaved name");
  console.log(
    "PASS pending car and settings drafts survive live updates; rejected Done retains the error and can be retried",
  );

  await host.locator("#edit-bots").selectOption(["Pizza Boy"]);
  await host.locator("#settings-form button[type=submit]").click();
  await eventually(view, (room) => room.modeOptions?.ffa.bots.length === 1);
  await host.locator("#prepare-match").click();
  await hostPlayer.waitForFunction(() =>
    window.commands.some((command) => command.action === "upload"),
  );
  let match = (await view()).match;
  assert(match);
  await host.locator("#cancel-preparation").click();
  await eventually(view, (room) => !room.match);
  await hostPlayer.waitForFunction(() =>
    window.commands.some((command) => command.action === "stop"),
  );
  await host.waitForFunction(() => !document.getElementById("prepare-match").disabled);
  await host.locator("#prepare-match").click();
  await hostPlayer.waitForFunction(
    () => window.commands.filter((command) => command.action === "upload").length === 2,
  );
  match = (await view()).match;
  await post(`match/${match.id}/prepare`);
  await eventually(view, (room) => room.match?.stage === "ready");
  for (const page of [host, guest]) {
    await page
      .locator("#server-region")
      .filter({ hasText: "Western Europe · Germany · FRA" })
      .waitFor();
    await choose(page, "Orbital");
  }
  await host.waitForFunction(() => !document.getElementById("start-match").disabled);
  await host.locator("#start-match").click();
  for (const frame of [hostPlayer, guestPlayer])
    await frame.waitForFunction(
      () => window.commands.filter((command) => command.action === "join").length === 1,
    );
  const servers = await mf.getDurableObjectNamespace("SERVER");
  const authority = servers.get(servers.idFromName(id + ":" + match.id));
  const prepared = await authority.inspectForTest();
  assert.deepEqual(prepared.bots, ["Pizza Boy"]);
  assert.equal(prepared.players, 4);
  assert.equal(prepared.roster.length, 2);
  await eventually(view, (room) => room.match?.stage === "playing");
  assert.equal((await view()).freePlaces, 2);
  console.log("PASS room startup forwards bots separately from the human credential roster");
  const late = await contexts[2].newPage();
  await late.goto(invite);
  await late.locator("#join-player").fill("Late human");
  await late.locator("#join-form button").click();
  await late.locator("#leave-button").waitFor();
  const latePlayer = await player(late);
  await loaded(latePlayer);
  await choose(late, "Orbital");
  await latePlayer.waitForFunction(() =>
    window.commands.some((command) => command.action === "join"),
  );
  assert.equal((await view()).freePlaces, 1);
  await late.locator("#leave-button").click();
  await late.waitForURL(origin + "/");
  await eventually(view, (room) => room.freePlaces === 2);
  console.log("PASS late human joins a bot match and departure releases only the human place");
  await host.locator("#reconnect-match").click();
  await hostPlayer.waitForFunction(
    () => window.commands.filter((command) => command.action === "join").length === 2,
  );
  assert.equal(
    await hostPlayer.evaluate(
      () => window.commands.filter((command) => command.action === "stop").length,
    ),
    2,
    "Both cancelled preparation and reconnect must stop the player operation",
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
