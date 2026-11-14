import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";

const { runtime, eventually } = await import("../rooms/runtime.ts");
const mf = await runtime(true);
let browser;
try {
  const url = (await mf.ready).origin;
  browser = await launchBrowser();
  const contextA = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const contextB = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const errors = [],
    requests = [];
  for (const context of [contextA, contextB])
    context.on("page", (page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => requests.push(request.url()));
    });
  const a = await contextA.newPage(),
    b = await contextB.newPage();
  await a.goto(url);
  await a.getByText("No public rooms yet.", { exact: false }).waitFor();
  await a.screenshot({ path: "build/room-tests/directory-empty.png", fullPage: true });
  await a.locator("#create-player").fill("Ada");
  await a.locator("#create-name").fill("Night shift");
  assert.equal(await a.locator("#create-form input").count(), 2);
  assert.equal(await a.locator("#create-form select").count(), 0);
  const creationRequest = a.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/rooms",
  );
  await a.locator("#create-form button").click();
  assert.deepEqual(Object.keys((await creationRequest).postDataJSON()).sort(), [
    "name",
    "playerName",
    "requestId",
  ]);
  await a.waitForURL(/\/rooms\/[a-f0-9]{32}$/);
  await a.locator("#settings-panel").waitFor();
  await a.getByText("Ada (you)", { exact: true }).waitFor();
  assert.equal(await a.locator("#edit-mode option").count(), 1);
  assert.equal(await a.locator("#edit-mode").inputValue(), "deathmatch");
  assert.equal(await a.locator("#edit-map").inputValue(), "construction-yard");
  assert.equal(await a.locator("#edit-capacity").inputValue(), "8");
  const invite = await a.locator("#invite-link").inputValue();
  assert.match(invite, /^http:\/\/[^/]+\/rooms\/[a-f0-9]{32}$/);
  await b.goto(url);
  await b.getByRole("heading", { name: "Night shift", exact: true }).waitFor();
  assert.equal(await b.locator(".card-mode").textContent(), "Deathmatch");
  assert.equal(await b.locator(".card-map").textContent(), "Construction Yard");
  assert.equal(await b.locator(".card-count").textContent(), "1 / 8 players");
  assert.equal(await b.locator(".availability").textContent(), "7 places free");
  await b.screenshot({ path: "build/room-tests/directory.png", fullPage: true });
  await b.getByRole("link", { name: "Join room" }).click();
  await b.locator("#join-player").fill("Boris");
  await b.locator("#join-form button").click();
  await b.getByText("Boris (you)", { exact: true }).waitFor();
  await a.getByText("Boris", { exact: true }).waitFor();
  assert.equal(await a.locator("#participants li").count(), 2);
  assert(await b.locator("#settings-panel").isHidden());
  await a.locator("#edit-name").fill("Oil crew");
  await a.locator("#edit-map").selectOption("the-oil-rig");
  await a.locator("#edit-capacity").selectOption("2");
  await a.locator("#settings-form button").click();
  await b.locator("#room-name").filter({ hasText: "Oil crew" }).waitFor();
  assert.equal(await b.locator("#room-map").textContent(), "The Oil Rig");
  await a.reload();
  await a.locator("#settings-panel").waitFor();
  assert.equal(await a.locator("#participants li").count(), 2);
  assert.equal(await a.locator("#room-capacity").textContent(), "2 / 2 players");
  assert.equal(await a.evaluate(() => document.cookie), "", "session credential is HttpOnly");
  const cookies = await contextA.cookies();
  assert(cookies.find((cookie) => cookie.name === "rm4_session").httpOnly);
  const secondTab = await contextA.newPage();
  await secondTab.goto(invite);
  await secondTab.locator("#settings-panel").waitFor();
  assert.equal(
    await secondTab.locator("#participants li").count(),
    2,
    "second tab does not duplicate membership",
  );
  await a.screenshot({ path: "build/room-tests/room.png", fullPage: true });
  await secondTab.locator("#leave-button").click();
  await secondTab.waitForURL(url + "/");
  await b.locator("#settings-panel").waitFor();
  await a.locator("#join-panel").waitFor();
  assert.equal(await b.locator("#participants li").count(), 1);
  assert.equal(await b.locator("#room-free").textContent(), "1 place free");
  await secondTab.getByText("Hosted by Boris", { exact: true }).waitFor();
  await b.locator("#leave-button").click();
  await b.waitForURL(url + "/");
  const id = new URL(invite).pathname.split("/").pop();
  await eventually(
    async () => (await fetch(`${url}/api/rooms/${id}`)).status,
    (status) => status === 404,
    34_000,
  );
  await b.getByText("No public rooms yet.", { exact: false }).waitFor();
  await b.setViewportSize({ width: 390, height: 844 });
  await b.screenshot({ path: "build/room-tests/mobile.png", fullPage: true });
  assert(
    await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "mobile layout must not overflow",
  );
  assert(
    !requests.some((request) => /\.wasm|\/api\/(prepare|start|resources)|\/match/.test(request)),
    "rooms never request simulation startup or game assets",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS two browser identities: live directory/join/settings, reload, multiple tabs, invite privacy, host transfer, leave, empty cleanup and mobile layout",
  );
  console.log(`Local preview: bun run dev:rustymetal4.com → http://localhost:8787`);
} finally {
  await browser?.close();
  await mf.dispose();
}
