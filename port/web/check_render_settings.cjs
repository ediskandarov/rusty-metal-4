const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, args: ['--enable-unsafe-swiftshader'],
    });
    try {
        const page = await browser.newPage({viewport: {width: 1200, height: 720}});
        const errors = [];
        let rendererInitializations = 0;
        page.on('console', message => {
            if (/opengl .* initialized/.test(message.text())) ++rendererInitializations;
        });
        page.on('pageerror', error => errors.push(String(error)));
        await page.addInitScript(() => {
            const blit = WebGL2RenderingContext.prototype.blitFramebuffer;
            WebGL2RenderingContext.prototype.blitFramebuffer = function(...args) {
                const result = blit.apply(this, args);
                const error = this.getError();
                if (error) (globalThis.renderGlErrors ||= []).push(error);
                return result;
            };
        });
        await page.goto(process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/');
        await require('./browser_startup.cjs')(page);
        assert.equal(await page.locator('#render-scale').inputValue(), '0');
        assert.equal(await page.locator('#subpixel-vertices').isChecked(), true);
        assert.equal(await page.locator('#perspective-textures').isChecked(), true);
        assert.equal(await page.locator('#render-interpolation').isChecked(), false);
        const checkSettings = async label => {
            await page.locator('#render-settings summary').click();
            for (const [id, key, values] of [
                ['car-lod-distance', 'carLodDistance', [2, 4, 8, 1]],
                ['draw-distance', 'drawDistance', [2, 4, 8, 1]],
                ['render-dithering', 'renderDithering', [1, 0]],
                ['render-vsync', 'renderVsync', [1, 3, 2]],
            ]) {
                for (const value of values) {
                    const before = await page.evaluate(() => tm4Port.screen === 'level' ? tm4Port.levelFrames : tm4Port.frames);
                    await page.selectOption(`#${id}`, String(value));
                    await page.waitForFunction(([key, value, before]) => tm4Port[key] === value &&
                        (tm4Port.screen === 'level' ? tm4Port.levelFrames : tm4Port.frames) > before + 2,
                        [key, value, before]);
                    console.log('PASS', label, id, value);
                }
            }
            await page.selectOption('#render-scale', '0');
            await page.waitForFunction(() => tm4Port.renderScale === 3);
            await page.selectOption('#render-scale', '3');
            await page.selectOption('#render-dithering', '1');
            await page.selectOption('#render-vsync', '2');
            await page.waitForFunction(() => tm4Port.renderScale === 3 && tm4Port.renderDithering === 1 &&
                tm4Port.renderVsync === 2);
            await page.locator('#subpixel-vertices').check();
            await page.waitForFunction(() => tm4Port.subpixelVertices === true);
            const counter = page.locator('#fps-counter');
            await page.locator('#render-fps').check();
            await page.waitForFunction(() => /^FPS [0-9]/.test(document.getElementById('fps-counter').textContent));
            const fps = Number((await counter.textContent()).slice(4));
            assert(fps > 0 && fps < 240, `unexpected FPS ${fps}`);
            console.log('PASS', label, 'FPS', fps);
            await page.screenshot({path: `build/web/render-settings-${label}.png`});
            await page.selectOption('#car-lod-distance', '8');
            await page.waitForFunction(() => tm4Port.carLodDistance === 8);
            await page.selectOption('#draw-distance', '8');
            await page.waitForFunction(() => tm4Port.drawDistance === 8);
            await page.locator('#render-interpolation').check();
            if (label === 'game') await page.waitForFunction(() => tm4Port.interpolateMotion === true);
            await page.locator('#render-reset').click();
            assert.equal(await page.locator('#render-interpolation').isChecked(), false);
            if (label === 'game') await page.waitForFunction(() => tm4Port.interpolateMotion === false);
            assert.equal(await counter.isVisible(), false);
            assert.equal(await page.locator('#render-fps').isChecked(), false);
            assert.equal(await page.locator('#subpixel-vertices').isChecked(), true);
            assert.equal(await page.locator('#perspective-textures').isChecked(), true);
            await page.waitForFunction(() => tm4Port.subpixelVertices === true && tm4Port.perspectiveTextures === true);
            await page.waitForFunction(() => tm4Port.drawDistance === 1 && tm4Port.carLodDistance === 1 && tm4Port.renderScale === 3 && tm4Port.renderDithering === 0 &&
                tm4Port.renderVsync === 2);
            for (const [id, value] of [['render-scale', '0'], ['render-dithering', '0'],
                ['render-vsync', '2'], ['car-lod-distance', '1'], ['draw-distance', '1']]) {
                assert.equal(await page.locator(`#${id}`).inputValue(), value);
            }
            await page.locator('#render-vsync').focus();
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#render-settings').evaluate(node => node.open), false);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'canvas');
            // PsyZ's desktop Escape shortcut must not destroy the browser renderer.
            const presented = await page.evaluate(() => Module._WebGetPresentedFrames());
            assert(rendererInitializations > 0);
            const initializations = rendererInitializations;
            await page.keyboard.down('Escape');
            await page.waitForTimeout(200);
            await page.keyboard.up('Escape');
            await page.waitForFunction(before => Module._WebGetPresentedFrames() > before + 3,
                presented, {timeout: 5000});
            assert.equal(rendererInitializations, initializations, 'Escape must not recreate the renderer');
            console.log('PASS', label, 'Escape preserves the renderer and keeps presenting frames');
        };
        await checkSettings('menu');
        for (const [width, height, scale] of [[640, 480, 2], [320, 480, 1], [1600, 900, 3], [1200, 720, 3]]) {
            await page.setViewportSize({width, height});
            await page.waitForFunction(scale => tm4Port.renderScale === scale, scale);
            console.log('PASS auto scale follows viewport', {width, height, scale});
        }
        // Arrow keys in the graphics panel must not select another game-menu item.
        const selection = await page.evaluate(() => tm4Port.selected);
        assert.equal(typeof selection, 'number');
        await page.locator('#render-settings summary').click();
        await page.locator('#render-dithering').focus();
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => tm4Port.selected), selection);
        await page.keyboard.press('Escape');
        const press = async key => {
            await page.keyboard.down(key); await page.waitForTimeout(150);
            await page.keyboard.up(key); await page.waitForTimeout(300);
        };
        const screen = name => page.waitForFunction(name => tm4Port.screen === name && tm4Port.menuReady,
            name, {timeout: 30000});
        await press('x'); await screen('newgame');
        await press('x'); await screen('carsel'); await press('x');
        await page.waitForFunction(() => tm4Port.screen === 'level' && tm4Port.levelFrames > 30,
            null, {timeout: 30000});
        await checkSettings('game');
        await page.setViewportSize({width: 320, height: 480});
        await page.locator('#render-settings summary').click();
        const box = await page.locator('#render-panel').boundingBox();
        assert(box.x >= 0 && box.x + box.width <= 320 && box.y + box.height <= 480);
        await page.screenshot({path: 'build/web/render-settings-narrow.png'});
        await page.mouse.click(4, 450);
        assert.equal(await page.locator('#render-settings').evaluate(node => node.open), false);
        assert.deepEqual(await page.evaluate(() => globalThis.renderGlErrors || []), []);
        assert.deepEqual(errors, []);
        console.log('PASS defaults, keyboard, narrow layout, no JS/GL errors');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
