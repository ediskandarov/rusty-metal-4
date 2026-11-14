import assert from "node:assert/strict";

/* global tm4Port, Module */
import diagnostics from "./browser_diagnostics.mjs";
import { launchBrowser } from "./helpers/browser.mjs";
import { setPanelOpen, startDiagnosticGame, togglePanel } from "./helpers/player.mjs";

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const errors = [];
  await diagnostics(page);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    const proto = WebGL2RenderingContext.prototype;
    const positions = new Map();
    const attribute = proto.vertexAttribPointer;
    const upload = proto.bufferSubData;
    proto.vertexAttribPointer = function (index, size, type, normalized, stride, offset) {
      if (index === 0 && size === 2 && type === this.FLOAT) {
        positions.set(this.getParameter(this.ARRAY_BUFFER_BINDING), { stride, offset });
      }
      return attribute.call(this, index, size, type, normalized, stride, offset);
    };
    proto.bufferSubData = function (target, destination, source, start, length) {
      if (target === this.ARRAY_BUFFER && globalThis.tm4CaptureVertices) {
        const format = positions.get(this.getParameter(this.ARRAY_BUFFER_BINDING));
        if (format && source instanceof Uint8Array && length) {
          const bytes = new DataView(source.buffer, source.byteOffset + start, length);
          const uploaded = (globalThis.tm4UploadedPositions ||= new Set());
          for (let offset = format.offset; offset + 8 <= length; offset += format.stride) {
            const x = bytes.getFloat32(offset, true);
            const y = bytes.getFloat32(offset + 4, true);
            if (!Number.isInteger(x) || !Number.isInteger(y)) uploaded.add(`${x},${y}`);
          }
        }
      }
      return upload.apply(this, arguments);
    };
  });
  await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8080/");
  await startDiagnosticGame(page);
  const press = async (key) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
    await page.waitForTimeout(200);
  };
  const screen = (name) =>
    page.waitForFunction((name) => tm4Port.screen === name && tm4Port.menuReady, name, {
      timeout: 30000,
    });
  await press("x");
  await screen("newgame");
  await press("x");
  await screen("carsel");

  const scale = 4;
  await togglePanel(page, "render-settings");
  await page.selectOption("#render-scale", String(scale));
  await page.waitForFunction((scale) => tm4Port.renderScale === scale, scale);
  await setPanelOpen(page, "render-settings", false);
  await page.locator("canvas").focus();
  const checkbox = page.locator("#subpixel-vertices");
  assert.equal(await checkbox.isChecked(), true);
  await setPanelOpen(page, "render-settings", true);
  await checkbox.uncheck();
  await setPanelOpen(page, "render-settings", false);
  await page.waitForFunction(() => tm4Port.subpixelVertices === false);
  await page.evaluate(() => {
    if (typeof Module._WebTestSetPreviewAngle !== "function")
      throw Error("Build with TM4_WEB_TEST_HOOKS=ON");
    globalThis.tm4CaptureVertices = true;
  });
  const preview = async (angle) => {
    const start = await page.evaluate((angle) => {
      globalThis.tm4UploadedPositions = new Set();
      Module._WebTestSetPreviewAngle(angle);
      return tm4Port.frames;
    }, angle);
    await page.waitForFunction(
      ([angle, start]) => tm4Port.testPreviewAngle === angle && tm4Port.frames > start + 2,
      [angle, start],
    );
    return page.evaluate(() => {
      const frame = tm4Port.subpixelFrame;
      const uploaded = globalThis.tm4UploadedPositions || new Set();
      return {
        ...frame,
        uploads: uploaded.size,
        firstUploaded: frame.first && uploaded.has(frame.first.slice(2).join(",")),
      };
    });
  };
  const toggle = async (enabled) => {
    await setPanelOpen(page, "render-settings", true);
    await checkbox.setChecked(enabled);
    await page.waitForFunction((enabled) => tm4Port.subpixelVertices === enabled, enabled);
    await setPanelOpen(page, "render-settings", false);
    await page.locator("canvas").focus();
  };

  const off = await preview(16);
  assert.equal(off.submitted, 0);
  assert.equal(off.uploads, 0);
  await toggle(true);
  let pair;
  let previous;
  for (let angle = 16; angle <= 40; ++angle) {
    const frame = await preview(angle);
    assert(frame.fractional > 100, "preview should submit a fractional mesh");
    assert(frame.uploads > 40, "actual WebGL position buffer should contain fractional vertices");
    if (
      frame.firstUploaded &&
      previous?.firstUploaded &&
      frame.first.slice(0, 2).join(",") === previous.first.slice(0, 2).join(",") &&
      frame.first.slice(2).join(",") !== previous.first.slice(2).join(",")
    ) {
      pair = [angle, previous.first, frame.first];
      break;
    }
    previous = frame;
  }
  assert(pair, "a slow rotation should move a vertex within the same original pixel");
  console.log(
    "PASS preview at fixed render scale",
    scale,
    "adjacent angles",
    pair[0] - 1,
    pair[0],
    "legacy x/y then WebGL x/y",
    pair[1],
    pair[2],
  );
  const screenshot = async (suffix) => {
    if (process.env.TM4_TEST_SCREENSHOTS)
      await page.screenshot({ path: `build/checks/subpixel-preview-${suffix}.png` });
  };
  await screenshot("on");
  await toggle(false);
  const restored = await preview(pair[0]);
  assert.equal(restored.submitted, 0);
  assert.equal(restored.uploads, 0);
  await screenshot("off");
  await page.evaluate(() => {
    globalThis.tm4CaptureVertices = false;
    Module._WebTestSetPreviewAngle(-1);
  });

  await press("x");
  await page.waitForFunction(() => tm4Port.screen === "level" && tm4Port.levelFrames > 20, null, {
    timeout: 30000,
  });
  await toggle(true);
  await page.waitForFunction(
    () => tm4Port.subpixelFrame.buffer > 0 && tm4Port.subpixelFrame.fractional > 500,
  );
  const before = await page.evaluate(() => tm4Port.levelFrames);
  await page.keyboard.down("x");
  await page.waitForFunction((before) => tm4Port.levelFrames > before + 8, before);
  await page.keyboard.up("x");
  const level = await page.evaluate(() => tm4Port.subpixelFrame);
  assert(level.fractional > 500);
  console.log("PASS gameplay vertex submission and driving", level);
  await toggle(false);
  assert.equal(await page.evaluate(() => tm4Port.subpixelFrame.submitted), 0);
  assert.equal(await page.evaluate(() => tm4Port.renderScale), scale);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
