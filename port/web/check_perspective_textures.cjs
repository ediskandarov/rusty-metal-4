const {chromium} = require('playwright');
const assert = require('node:assert/strict');

async function observeUploads(page) {
    await page.addInitScript(() => {
        const gl = WebGL2RenderingContext.prototype;
        const formats = new Map();
        const attrib = gl.vertexAttribPointer;
        const upload = gl.bufferSubData;
        const blit = gl.blitFramebuffer;
        gl.blitFramebuffer = function() {
            const result = blit.apply(this, arguments);
            const probe = globalThis.textureProbe;
            const sourceX = arguments[0];
            if (probe?.images && !probe.images.has(sourceX) &&
                !this.getParameter(this.DRAW_FRAMEBUFFER_BINDING)) {
                const source = this.getParameter(this.READ_FRAMEBUFFER_BINDING);
                this.bindFramebuffer(this.READ_FRAMEBUFFER, null);
                // Read the car and shadow at 960×720 from the actual presentation.
                const pixels = new Uint8Array(450 * 180 * 4);
                this.readPixels(435, 180, 450, 180, this.RGBA, this.UNSIGNED_BYTE, pixels);
                this.bindFramebuffer(this.READ_FRAMEBUFFER, source);
                let hash = 2166136261;
                for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
                probe.images.set(sourceX, hash);
            }
            return result;
        };
        gl.vertexAttribPointer = function(index, size, type, normalized, stride, offset) {
            const buffer = this.getParameter(this.ARRAY_BUFFER_BINDING);
            if (index === 0 && size === 2 && type === this.FLOAT) {
                formats.set(buffer, {stride, xy: offset});
            } else if (formats.has(buffer) && (index === 1 || index === 2 || index === 4)) {
                formats.get(buffer)[index] = offset;
            }
            return attrib.apply(this, arguments);
        };
        gl.bufferSubData = function(target, destination, source, start, length) {
            const probe = globalThis.textureProbe;
            if (probe && target === this.ARRAY_BUFFER && source instanceof Uint8Array && length) {
                const format = formats.get(this.getParameter(this.ARRAY_BUFFER_BINDING));
                if (format) {
                    const bytes = new DataView(source.buffer, source.byteOffset + start, length);
                    for (let at = 0; at < length; at += format.stride) {
                        const x = bytes.getFloat32(at + format.xy, true);
                        const y = bytes.getFloat32(at + format.xy + 4, true);
                        const depth = format[4] === undefined ? 0 : bytes.getFloat32(at + format[4], true);
                        const uv = at + format[1];
                        const tpage = bytes.getUint16(uv + 6, true);
                        if ((tpage & 0xa000) !== 0x2000) {
                            if (depth !== 0) ++probe.unexpectedDepth;
                            continue;
                        }
                        // Ignore the animated menu outside the fixed car preview.
                        if (probe.images && (x < 145 || x > 295 || y < 120 || y > 180)) continue;
                        const attributes = [x, y, bytes.getUint32(uv, true),
                            bytes.getUint32(uv + 4, true), bytes.getUint32(at + format[2], true)];
                        probe.vertices.add(attributes.join(','));
                        if (!Number.isInteger(x) || !Number.isInteger(y)) ++probe.fractional;
                        if (depth > 0) probe.depths.add(depth);
                    }
                }
            }
            return upload.apply(this, arguments);
        };
    });
}

async function openPreview(browser, url) {
    const page = await browser.newPage({viewport: {width: 960, height: 720}});
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await require('./browser_diagnostics.cjs')(page);
    await observeUploads(page);
    await page.goto(url);
    await require('./browser_startup.cjs')(page);
    const press = async key => {
        await page.keyboard.down(key);
        await page.waitForTimeout(150);
        await page.keyboard.up(key);
        await page.waitForTimeout(200);
    };
    const screen = name => page.waitForFunction(name => tm4Port.screen === name && tm4Port.menuReady,
        name, {timeout: 30000});
    await press('x'); await screen('newgame');
    await press('x'); await screen('carsel');
    for (let i = 0; i < 22 && await page.evaluate(() => tm4Port.selectedCar !== 'Orbital'); ++i)
        await press('ArrowRight');
    assert.equal(await page.evaluate(() => tm4Port.selectedCar), 'Orbital');
    return {page, press, errors};
}

async function preview(page, angle, scale, stabilize, perspective, baseline = false) {
    await page.locator('#render-settings').evaluate(node => { node.open = true; });
    await page.selectOption('#render-scale', String(scale));
    await page.locator('#subpixel-vertices').setChecked(stabilize);
    if (!baseline) await page.locator('#perspective-textures').setChecked(perspective);
    await page.locator('#render-settings').evaluate(node => { node.open = false; });
    await page.locator('canvas').focus();
    await page.evaluate(angle => Module._WebTestSetPreviewAngle(angle), angle);
    await page.waitForFunction(({angle, scale, stabilize, perspective, baseline}) =>
        tm4Port.testPreviewAngle === angle && tm4Port.renderScale === scale &&
        tm4Port.subpixelVertices === stabilize && (baseline || tm4Port.perspectiveTextures === perspective),
    {angle, scale, stabilize, perspective, baseline});
    // Let both displayed menu buffers pick up the angle and settings before reading.
    const warmup = await page.evaluate(() => tm4Port.frames);
    await page.waitForFunction(start => tm4Port.frames >= start + 4, warmup);
    const start = await page.evaluate(() => {
        globalThis.textureProbe = {
            images: new Map(), vertices: new Set(), depths: new Set(), fractional: 0, unexpectedDepth: 0,
        };
        return tm4Port.frames;
    });
    await page.waitForFunction(start => tm4Port.frames >= start + 4, start);
    const sample = await page.evaluate(() => {
        const {images, vertices, depths, fractional, unexpectedDepth} = textureProbe;
        globalThis.textureProbe = null;
        return {images: [...images].sort(([a], [b]) => a - b), vertices: [...vertices].sort(),
            depths: [...depths], fractional, unexpectedDepth};
    });
    assert(sample.vertices.length > 100);
    assert.equal(sample.fractional > 0, stabilize);
    assert.equal(sample.unexpectedDepth, 0);
    assert.equal(sample.depths.length > 20, perspective);
    if (perspective) assert(Math.max(...sample.depths) / Math.min(...sample.depths) > 1.1);
    assert.equal(sample.images.length, 2, 'sample both alternating menu buffers');
    return sample;
}

(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, args: ['--enable-unsafe-swiftshader'],
    });
    try {
        const {page, press, errors} = await openPreview(browser,
            process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/');
        const baseline = process.env.TM4_WEB_BASELINE_URL &&
            await openPreview(browser, process.env.TM4_WEB_BASELINE_URL);
        assert.equal(await page.locator('#perspective-textures').isChecked(), true);
        for (const [angle, scale] of [[16, 2], [690, 4]]) {
            for (const stabilize of [false, true]) {
                const affine = await preview(page, angle, scale, stabilize, false);
                const corrected = await preview(page, angle, scale, stabilize, true);
                assert.deepEqual(corrected.vertices, affine.vertices, 'texture mode preserves XY, UV, and color uploads');
                assert(corrected.images.every(([origin, hash], i) =>
                    origin === affine.images[i][0] && hash !== affine.images[i][1]),
                    'texture correction should visibly change the car in both buffers');
                if (baseline) {
                    const old = await preview(baseline.page, angle, scale, stabilize, false, true);
                    assert.deepEqual(affine.vertices, old.vertices);
                    assert.deepEqual(affine.images, old.images,
                        'affine preview should match the baseline pixels for both menu buffers');
                }
                console.log('PASS Orbital preview', {angle, scale, stabilize, depths: corrected.depths.length});
            }
        }
        await baseline?.page.close();

        await press('x');
        await page.waitForFunction(() => tm4Port.screen === 'level' && tm4Port.levelFrames > 20,
            null, {timeout: 30000});
        await page.evaluate(() => {
            let frame = tm4Port.subpixelFrame;
            globalThis.textureBuffers = new Set();
            Object.defineProperty(tm4Port, 'subpixelFrame', {
                get: () => frame,
                set: next => {
                    frame = next;
                    textureBuffers.add(next.buffer);
                },
            });
            globalThis.textureProbe = {vertices: new Set(), depths: new Set(), fractional: 0, unexpectedDepth: 0};
        });
        await page.waitForFunction(() => textureBuffers.has(1) && textureBuffers.has(2) &&
            textureProbe.depths.size > 100);
        const level = await page.evaluate(() => {
            const {depths, unexpectedDepth} = textureProbe;
            globalThis.textureProbe = null;
            return {depths: depths.size, unexpectedDepth};
        });
        assert.equal(level.unexpectedDepth, 0);
        console.log('PASS gameplay perspective uploads across both ordering tables', level);
        await page.locator('#render-settings').evaluate(node => { node.open = true; });
        await page.locator('#render-fps').setChecked(true);
        await page.locator('#render-reset').click();
        assert.equal(await page.locator('#perspective-textures').isChecked(), true);
        assert.equal(await page.locator('#subpixel-vertices').isChecked(), true);
        assert.equal(await page.locator('#render-vsync').inputValue(), '2');
        assert.equal(await page.locator('#render-fps').isChecked(), false);
        assert.equal(await page.locator('#cheat-settings').isVisible(), true);
        await page.waitForFunction(() => tm4Port.perspectiveTextures && tm4Port.subpixelVertices &&
            tm4Port.renderScale === 3);
        assert.deepEqual(errors, []);
        if (baseline) assert.deepEqual(baseline.errors, []);
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
