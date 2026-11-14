const assert = require("node:assert/strict");
const { launchBrowser } = require("./helpers/browser.cjs");

(async () => {
  const { runtime, eventually } = await import("../rooms/runtime.ts");
  const mf = await runtime(true);
  let browser;
  try {
    const url = (await mf.ready).origin;
    browser = await launchBrowser();
    const hostContext = await browser.newContext();
    const host = await hostContext.newPage();
    const errors = [];
    host.on("pageerror", (error) => errors.push(error.message));
    await host.goto(url);
    await host.locator("#create-player").fill("Recovery host");
    await host.locator("#create-name").fill("Recovery test");
    await host.locator("#create-form button").click();
    await host.waitForURL(/\/rooms\/[a-f0-9]{32}$/);
    await host.locator("#room-status").filter({ hasText: "Live room" }).waitFor();
    const invite = host.url();
    const id = new URL(invite).pathname.split("/").pop();
    const snapshot = async (context) =>
      (await (await context.request.get(`${url}/api/rooms/${id}`)).json()).room;
    const original = await snapshot(hostContext);
    let restoredSockets = 0;
    host.on("websocket", (socket) => {
      if (socket.url().includes(id)) restoredSockets++;
    });
    await host.route(
      `**/api/rooms/${id}`,
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Snapshot temporarily unavailable." }),
        }),
      { times: 1 },
    );
    await host.reload();
    await host.getByText("Snapshot temporarily unavailable.", { exact: true }).waitFor();
    await host.locator("#room-status").filter({ hasText: "Live room" }).waitFor();
    const restored = await eventually(
      () => snapshot(hostContext),
      (state) => state.participants.find((member) => member.id === state.you)?.connected,
    );
    assert.equal(restored.you, original.you);
    assert.equal(restored.hostId, original.hostId);
    assert.equal(restored.participantCount, 1);
    assert.equal(restoredSockets, 1, "snapshot recovery opens exactly one replacement socket");
    assert(await host.locator("#room-error").isHidden());
    console.log("PASS an initial snapshot 503 recovers host identity and its live connection");

    await host.route(
      "**/api/session",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Host session temporarily unavailable." }),
        }),
      { times: 1 },
    );
    await host.reload();
    await host.getByText("Host session temporarily unavailable.", { exact: true }).waitFor();
    await host.locator("#room-status").filter({ hasText: "Live room" }).waitFor();
    const sessionRestored = await eventually(
      () => snapshot(hostContext),
      (state) => state.participants.find((member) => member.id === state.you)?.connected,
    );
    assert.equal(sessionRestored.you, original.you);
    assert.equal(sessionRestored.hostId, original.hostId);
    assert.equal(restoredSockets, 2);
    console.log("PASS an initial session 503 on host reload restores the existing host and socket");

    const guestContext = await browser.newContext();
    const observer = await guestContext.newPage();
    observer.on("pageerror", (error) => errors.push(error.message));
    let observerSockets = 0;
    observer.on("websocket", (socket) => {
      if (socket.url().includes(id)) observerSockets++;
    });
    await observer.route(
      "**/api/session",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Session temporarily unavailable." }),
        }),
      { times: 1 },
    );
    await observer.goto(invite);
    await observer.getByText("Session temporarily unavailable.", { exact: true }).waitFor();
    await observer.locator("#join-panel").waitFor();
    assert.equal((await snapshot(guestContext)).you, null);
    assert((await guestContext.cookies()).some((cookie) => cookie.name === "rm4_session"));
    assert.equal(observerSockets, 0);
    console.log("PASS an initial session 503 retries session creation before loading the room");

    const joiningTab = await guestContext.newPage();
    joiningTab.on("pageerror", (error) => errors.push(error.message));
    await joiningTab.goto(invite);
    await joiningTab.locator("#join-player").fill("Recovered guest");
    await joiningTab.locator("#join-form button").click();
    await joiningTab.locator("#room-status").filter({ hasText: "Live room" }).waitFor();
    const joined = await snapshot(guestContext);
    await observer.locator("#room-status").filter({ hasText: "Live room" }).waitFor();
    assert.equal(
      observerSockets,
      1,
      "membership found by polling opens the observer tab's own socket",
    );
    assert.equal((await snapshot(guestContext)).you, joined.you);
    assert.equal((await snapshot(guestContext)).participantCount, 2);
    await joiningTab.close();
    await eventually(
      () => snapshot(guestContext),
      (state) => state.participants.find((member) => member.id === state.you)?.connected,
    );
    assert(await observer.locator("#join-panel").isHidden());
    assert(await observer.locator("#room-error").isHidden());
    await observer.locator("#leave-button").click();
    await host.locator("#leave-button").click();
    assert.deepEqual(errors, []);
    console.log(
      "PASS membership discovered after a same-browser tab joins retains its own live connection",
    );
  } finally {
    await browser?.close();
    await mf.dispose();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
