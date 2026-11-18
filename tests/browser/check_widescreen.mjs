import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { closeSettings, setPanelOpen, startDiagnosticGame } from "./helpers/player.mjs";

// Observe actual GPU uploads: move and scale the whole sprite while retaining
// its texture coordinates and palette.
async function observeHud(page) {
  await page.addInitScript(() => {
    const gl = WebGL2RenderingContext.prototype;
    const formats = new Map();
    const attribute = gl.vertexAttribPointer;
    const upload = gl.bufferSubData;
    gl.vertexAttribPointer = function (index, size, type, normalized, stride, offset) {
      const buffer = this.getParameter(this.ARRAY_BUFFER_BINDING);
      if (index === 0 && size === 2 && type === this.FLOAT)
        formats.set(buffer, { stride, xy: offset });
      if (index === 1 && formats.has(buffer)) formats.get(buffer).uv = offset;
      if (index === 2 && formats.has(buffer)) formats.get(buffer).color = offset;
      return attribute.apply(this, arguments);
    };
    gl.bufferSubData = function (target, destination, source, start, length) {
      const probe = globalThis.hudProbe;
      const format = formats.get(this.getParameter(this.ARRAY_BUFFER_BINDING));
      if (
        probe &&
        format &&
        target === this.ARRAY_BUFFER &&
        source instanceof Uint8Array &&
        length
      ) {
        const bytes = new DataView(source.buffer, source.byteOffset + start, length);
        for (let at = 0; at + 4 * format.stride <= length; at += format.stride) {
          const x = bytes.getFloat32(at + format.xy, true);
          const y = bytes.getFloat32(at + format.xy + 4, true);
          const id = probe.expected.findIndex(
            ([ex, ey]) => Math.abs(x - ex) < 0.01 && Math.abs(y - ey) < 0.01,
          );
          if (id < 0 || probe.found[id]) continue;
          if (
            probe.pause &&
            (bytes.getUint32(at + format.color, true) !== 0x80000000 ||
              !(bytes.getUint16(at + format.uv + 6, true) & 0x8000))
          )
            continue;
          const vertices = Array.from({ length: 4 }, (_, i) => {
            const base = at + i * format.stride;
            return {
              xy: [
                bytes.getFloat32(base + format.xy, true),
                bytes.getFloat32(base + format.xy + 4, true),
              ],
              uv: [
                bytes.getUint32(base + format.uv, true),
                // Ignore the backend-only transformed-sprite marker.
                (bytes.getUint32(base + format.uv + 4, true) & ~0x10000000) >>> 0,
              ],
            };
          });
          // Sprites expand into rectangular quads, not arbitrary world polygons.
          if (
            vertices[1].xy[1] === y &&
            vertices[2].xy[0] === x &&
            vertices[3].xy[0] === vertices[1].xy[0]
          )
            probe.found[id] = vertices;
        }
      }
      return upload.apply(this, arguments);
    };
  });
}

async function sampleHud(page, baseline, width = 320, height = 240) {
  const origins = [
    [9, 13],
    [10, 199],
    [250, 180],
  ];
  const pixelScale = Math.max(1, Math.min(Math.floor(width / 320), Math.floor(height / 240)));
  const transform = ([x, y], right) =>
    baseline
      ? [
          160 +
            ((right ? width : 0) + ((x - (right ? 320 : 0)) * height) / 240 - width / 2) /
              pixelScale,
          120 + ((y - 120) * height) / 240 / pixelScale,
        ]
      : [x, y];
  await page.evaluate(
    (expected) => {
      globalThis.hudProbe = { expected, found: [null, null, null] };
    },
    origins.map((xy, i) => transform(xy, i === 2)),
  );
  await page.waitForFunction(() => globalThis.hudProbe.found.every(Boolean));
  const found = await page.evaluate(() => {
    const result = globalThis.hudProbe.found;
    globalThis.hudProbe = null;
    return result;
  });
  if (baseline)
    for (let panel = 0; panel < found.length; ++panel) {
      for (let vertex = 0; vertex < 4; ++vertex) {
        assert.deepEqual(
          found[panel][vertex].uv,
          baseline[panel][vertex].uv,
          "HUD sprite retains its UVs and palette",
        );
        const expected = transform(baseline[panel][vertex].xy, panel === 2);
        for (let axis = 0; axis < 2; ++axis)
          assert(
            Math.abs(found[panel][vertex].xy[axis] - expected[axis]) < 0.01,
            "HUD anchors and scales the entire sprite",
          );
      }
    }
  return found;
}

async function checkPauseBackdrop(page, width = 320, height = 240) {
  const scale = Math.max(1, Math.min(Math.floor(width / 320), Math.floor(height / 240)));
  // PsyZ rounds the canvas to eight game pixels and centres the original frame.
  const w = Math.ceil(Math.floor(width / scale) / 8) * 8;
  const h = Math.ceil(Math.floor(height / scale) / 8) * 8;
  const x = (320 - w) / 2;
  const y = (240 - h) / 2;
  await page.evaluate(
    (origin) => {
      globalThis.hudProbe = { expected: [origin], found: [null], pause: true };
    },
    [x, y],
  );
  await page.waitForFunction(() => globalThis.hudProbe.found[0]);
  const vertices = await page.evaluate(() => {
    const quad = globalThis.hudProbe.found[0];
    globalThis.hudProbe = null;
    return quad.map((v) => v.xy);
  });
  assert.deepEqual(vertices, [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ]);
}

const browser = await launchBrowser();
try {
  for (const [width, height] of [
    [1280, 800],
    [1280, 720],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      screen: { width, height },
    });
    const page = await context.newPage();
    await observeHud(page);
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const press = async (key) => {
      await page.keyboard.press(key, { delay: 120 });
      await page.waitForTimeout(180);
    };
    const menu = (name) =>
      page.waitForFunction(
        (name) => globalThis.tm4Port.screen === name && globalThis.tm4Port.menuReady,
        name,
        { timeout: 30000 },
      );
    const wide = () => page.evaluate(() => !!globalThis.tm4Port.widescreen);
    const fullscreen = async () => {
      await page.locator("canvas").dblclick();
      await page.waitForFunction(() => !!document.fullscreenElement);
    };
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8376/");
    await startDiagnosticGame(page);
    await fullscreen();
    assert.equal(await wide(), false, "fullscreen menu stays 4:3");
    await page.screenshot({ path: `build/checks/fullscreen-menu-${height}.png` });
    await press("Escape");
    await page.waitForFunction(() => !document.fullscreenElement);
    await press("x");
    await menu("newgame");
    await press("x");
    await menu("carsel");
    await press("x");
    await page.waitForFunction(() => globalThis.tm4Port.levelFrames > 30, null, { timeout: 60000 });
    assert.equal(await wide(), false, "windowed battle stays 4:3");
    const baseline = await sampleHud(page);
    await page.screenshot({ path: `build/checks/windowed-battle-${height}.png` });
    await fullscreen();
    await page.waitForFunction(() => globalThis.tm4Port.widescreen);
    await sampleHud(page, baseline, width, height);
    await page.screenshot({ path: `build/checks/fullscreen-battle-${height}.png` });
    await setPanelOpen(page, "render-settings", true);
    await page.locator("#subpixel-vertices").uncheck();
    await page.locator("#perspective-textures").uncheck();
    await closeSettings(page);
    await page.waitForFunction(
      () => !globalThis.tm4Port.subpixelVertices && !globalThis.tm4Port.perspectiveTextures,
    );
    await sampleHud(page, baseline, width, height);
    await page.evaluate(() => globalThis.Module._WebTestSetAbbreviatedHud(1));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `build/checks/fullscreen-abbreviated-hud-${height}.png` });
    await page.evaluate(() => globalThis.Module._WebTestSetAbbreviatedHud(0));
    await sampleHud(page, baseline, width, height);
    await press("Escape");
    await page.waitForFunction(() => !document.fullscreenElement && !globalThis.tm4Port.widescreen);
    assert.deepEqual(
      await sampleHud(page),
      baseline,
      "Returning to 4:3 restores unchanged HUD packets",
    );
    assert(
      !(await page.evaluate(() => globalThis.tm4Port.paused)),
      "exiting fullscreen does not pause",
    );
    await fullscreen();
    await page.waitForFunction(() => globalThis.tm4Port.widescreen);
    await sampleHud(page, baseline, width, height);
    await page.keyboard.down("x");
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(2500);
    await page.keyboard.up("ArrowRight");
    await page.keyboard.up("x");
    await press("Enter");
    await page.waitForFunction(() => globalThis.tm4Port.paused);
    await checkPauseBackdrop(page, width, height);
    await page.screenshot({ path: `build/checks/fullscreen-pause-${height}.png` });
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !globalThis.tm4Port.widescreen && globalThis.tm4Port.paused);
    await checkPauseBackdrop(page);
    await fullscreen();
    await page.waitForFunction(() => globalThis.tm4Port.widescreen && globalThis.tm4Port.paused);
    await checkPauseBackdrop(page, width, height);
    await press("ArrowUp");
    await press("x");
    await press("ArrowUp");
    await press("x");
    await menu("main");
    assert.equal(await wide(), false, "returning to menu restores 4:3 without leaving fullscreen");
    assert(await page.evaluate(() => !!document.fullscreenElement));
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}x${height}: HUD anchors/scale/UVs, vertex correction on/off, abbreviated HUD, fullscreen transitions and pause`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
