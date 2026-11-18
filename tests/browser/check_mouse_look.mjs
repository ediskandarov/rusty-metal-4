import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { closeSettings, setPanelOpen, startDiagnosticGame } from "./helpers/player.mjs";

const browser = await launchBrowser();
try {
  const viewport = { width: 1280, height: 800 };
  const page = await browser.newPage({ viewport, screen: viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const orbit = () => page.evaluate(() => globalThis.tm4Port.mouseLook);
  const press = (key) => page.keyboard.press(key, { delay: 120 });
  const menu = (name) =>
    page.waitForFunction(
      (name) => globalThis.tm4Port.screen === name && globalThis.tm4Port.menuReady,
      name,
    );
  await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8376/");
  await startDiagnosticGame(page);
  await setPanelOpen(page, "render-settings", true);
  await page.locator("#render-scale").selectOption("1");
  await closeSettings(page);
  await press("x");
  await menu("newgame");
  await press("x");
  await menu("carsel");
  await press("x");
  await page.waitForFunction(() => globalThis.tm4Port.mouseLook?.ready);
  const canvas = page.locator("canvas");
  const { x, y, width, height } = await canvas.boundingBox();
  const startX = x + width / 2 - 240;
  const middleY = y + height / 2;
  async function waitForAngle(expected, tolerance = 0) {
    try {
      await page.waitForFunction(
        ([expected, tolerance]) =>
          Math.abs(globalThis.tm4Port.mouseLook.angle - expected) <= tolerance,
        [expected, tolerance],
        { timeout: 5000 },
      );
    } catch (cause) {
      throw new Error(`Expected angle ${expected} ± ${tolerance}, got ${(await orbit()).angle}`, {
        cause,
      });
    }
  }
  const waitForPitch = (expected) =>
    page.waitForFunction((expected) => globalThis.tm4Port.mouseLook.pitch === expected, expected, {
      timeout: 5000,
    });
  const rightClick = () => page.mouse.click(startX, middleY, { button: "right" });
  const lock = () =>
    page.waitForFunction(() => document.pointerLockElement?.id === "canvas", null, {
      timeout: 5000,
    });
  const unlock = () => page.waitForFunction(() => !document.pointerLockElement);

  await page.mouse.click(startX, middleY, { button: "right", delay: 250 });
  await page.mouse.move(startX + 120, middleY);
  assert.equal((await orbit()).angle, 0);
  assert.equal(await page.evaluate(() => document.pointerLockElement), null);

  await rightClick();
  await lock();
  await page.mouse.move(startX + 120, middleY, { steps: 8 });
  await waitForAngle(960, 240);
  const side = await orbit();
  assert(side.fraction >= 0 && side.fraction <= 1);
  await page.mouse.move(startX + 360, middleY, { steps: 12 });
  const oppositeAngle = side.angle - 2048;
  await waitForAngle(oppositeAngle, 40);
  const otherSide = await orbit();
  assert.notDeepEqual([otherSide.x, otherSide.z], [side.x, side.z]);
  await page.mouse.move(startX + 600, middleY, { steps: 12 });
  await waitForAngle(side.angle, 40);
  await page.mouse.move(startX + 360, middleY, { steps: 8 });
  await waitForAngle(oppositeAngle, 40);
  const level = await orbit();
  await page.mouse.move(startX + 360, middleY + 100, { steps: 8 });
  await waitForPitch(-512);
  const raised = await orbit();
  assert.equal(raised.angle, level.angle, "vertical movement preserves yaw");
  assert(raised.y < level.y, "looking down raises the camera around the car");
  assert(raised.forwardY > level.forwardY, "moving the mouse down looks down");

  await page.mouse.move(startX + 360, middleY - 30, { steps: 8 });
  await waitForPitch(171);
  const lowered = await orbit();
  assert.equal(lowered.angle, level.angle);
  assert(lowered.y > level.y, "looking up lowers the camera around the car");
  assert(lowered.forwardY < level.forwardY, "moving the mouse up looks up");

  await page.mouse.down({ button: "right" });
  await page.waitForTimeout(250);
  await page.mouse.up({ button: "right" });
  assert(Math.abs((await orbit()).angle - oppositeAngle) <= 40);
  assert.equal((await orbit()).pitch, 171);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await unlock();
  await waitForAngle(0);
  await waitForPitch(0);

  await canvas.dblclick();
  await page.waitForFunction(() => document.fullscreenElement && globalThis.tm4Port.widescreen);
  await rightClick();
  await lock();
  await page.mouse.move(startX + 120, middleY, { steps: 8 });
  await waitForAngle(960, 240);
  await press("Escape");
  await unlock();
  await waitForAngle(0);
  await waitForPitch(0);
  assert(await page.evaluate(() => !!document.fullscreenElement));
  assert(!(await page.evaluate(() => globalThis.tm4Port.paused)));

  await rightClick();
  await lock();
  await page.mouse.move(startX + 120, middleY, { steps: 8 });
  await waitForAngle(960, 240);
  await canvas.evaluate((element) => element.blur());
  await unlock();
  await waitForAngle(0);
  await waitForPitch(0);

  await canvas.evaluate((element) => {
    element.requestPointerLock = () => Promise.reject(new Error("Pointer lock denied"));
  });
  await rightClick();
  await page.mouse.move(startX, middleY + 100, { steps: 8 });
  await waitForPitch(-512);
  assert.equal((await orbit()).angle, 0, "pitch works without yaw and pointer lock");
  assert.equal(await page.evaluate(() => document.pointerLockElement), null);
  await press("Escape");
  await waitForPitch(0);

  await page.mouse.move(startX, middleY);
  await page.mouse.wheel(-120, 30);
  assert.equal((await orbit()).angle, 0, "trackpad gestures are opt-in");

  await setPanelOpen(page, "input-settings", true);
  await page.getByRole("checkbox", { name: "Trackpad look" }).check();
  await closeSettings(page);
  await page.mouse.move(startX, middleY);
  await page.mouse.wheel(-120, 30);
  await waitForAngle(1024);
  await waitForPitch(171);
  await page.waitForTimeout(350);
  assert.equal((await orbit()).angle, 1024, "camera stays in place after a swipe");
  assert.equal((await orbit()).pitch, 171);
  assert.equal(await page.evaluate(() => document.pointerLockElement), null);
  await canvas.evaluate((element) => {
    element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true }),
    );
  });
  assert.equal(
    await page.evaluate(() => globalThis.tm4MouseLook(true) >> 16),
    171,
    "pinch zoom leaves the camera pitch alone",
  );

  await page.mouse.wheel(-60, -30);
  await waitForAngle(1536);
  await waitForPitch(-85);
  await rightClick();
  await waitForAngle(0);
  await waitForPitch(0);
  assert.equal(await page.evaluate(() => document.pointerLockElement), null);

  // Deliver the end of a swipe and the recenter click in a single browser task.
  await canvas.evaluate((element) => {
    const wheel = (deltaX, deltaY) =>
      element.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY, cancelable: true }));
    wheel(120, 30);
    for (const type of ["mousedown", "mouseup"])
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 2 }));
    wheel(4, 2);
  });
  await page.waitForTimeout(350);
  assert.equal((await orbit()).angle, 0, "swipe momentum leaves the camera centered");
  assert.equal((await orbit()).pitch, 0);

  await page.mouse.wheel(120, 0);
  await waitForAngle(-1024);
  await press("Enter");
  await page.waitForFunction(
    () => globalThis.tm4Port.paused && !globalThis.tm4Port.mouseLook.ready,
  );
  await unlock();
  assert.equal((await orbit()).angle, 0);
  assert.equal((await orbit()).pitch, 0);
  assert.equal(
    await page.locator("html").getAttribute("data-trackpad-look"),
    null,
    "pause stops handling browser gestures for the game",
  );
  // Cross the same single-sided map face horizontally from opposite directions.
  const fractions = await page.evaluate(() => {
    const from = (x, endX) =>
      globalThis.Module._WebTestMouseLookFraction(x, -100, -8000, endX, -100, -8000);
    return [from(-2000, -1200), from(-1200, -2000)];
  });
  for (const fraction of fractions)
    assert(fraction > 0 && fraction < 1, `camera must stop before the wall: ${fractions}`);

  assert.deepEqual(errors, []);
  console.log(
    "PASS mouse orbit and opt-in two-finger look with persistent view, right-click recentering and pause",
  );
} finally {
  await browser.close();
}
