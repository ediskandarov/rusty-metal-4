const {chromium} = require('playwright');
const assert = require('node:assert/strict');

(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
        // Exercise the 60 Hz path even when headless Chrome defaults to a 30 Hz clock.
        args: ['--enable-unsafe-swiftshader', '--disable-frame-rate-limit'],
    });
    try {
        const page = await browser.newPage({viewport: {width: 720, height: 540}});
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        const press = async key => {
            await page.keyboard.down(key);
            await page.waitForTimeout(150);
            await page.keyboard.up(key);
            await page.waitForTimeout(150);
        };
        const menu = name => page.waitForFunction(name => tm4Port.screen === name && tm4Port.menuReady,
            name, {timeout: 30000});
        const state = () => page.evaluate(() => ({
            ms: performance.now(), frames: tm4Port.levelFrames, ticks: tm4Port.simulationTicks,
        }));
        const measure = async (label, minimum, maximum) => {
            const start = await state();
            await page.waitForTimeout(2500);
            const end = await state();
            const seconds = (end.ms - start.ms) / 1000;
            const frames = (end.frames - start.frames) / seconds;
            const ticks = (end.ticks - start.ticks) / seconds;
            console.log(label, {frames, ticks});
            assert(frames >= minimum && frames <= maximum, label + ' fresh frame rate');
            assert(ticks >= 28 && ticks <= 32, label + ' simulation tick rate');
        };

        await page.goto(process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/');
        await require('./browser_startup.cjs')(page);
        await page.locator('canvas').click();
        await press('x'); await menu('newgame');
        await press('x'); await menu('carsel');
        await press('x');
        await page.waitForFunction(() => tm4Port.screen === 'level' && tm4Port.levelFrames > 30,
            null, {timeout: 30000});
        const toggle = page.locator('#render-interpolation');
        assert.equal(await toggle.isChecked(), false);
        assert.equal(await page.evaluate(() => tm4Port.interpolateMotion), false);
        await measure('OFF', 26, 34);

        const rendering = page.locator('#render-settings summary');
        await rendering.click();
        await toggle.check();
        await page.waitForFunction(() => tm4Port.interpolateMotion && tm4Port.renderTiming.vblanks === 1);
        await measure('ON', 48, 66);

        await page.locator('canvas').click();
        const origin = await page.evaluate(() => [tm4Port.carX, tm4Port.carZ]);
        await page.keyboard.down('x');
        await page.waitForFunction(() => tm4Port.carThrottle === 15);
        await page.waitForFunction(([x, z]) => Math.hypot(tm4Port.carX - x, tm4Port.carZ - z) > 20, origin);
        await page.keyboard.up('x');
        await page.waitForFunction(() => tm4Port.carThrottle === 0);

        await press('Enter');
        await page.waitForFunction(() => tm4Port.paused === true);
        const paused = await state();
        await page.waitForTimeout(600);
        assert.equal((await state()).ticks, paused.ticks, 'pause freezes simulation');
        await press('x');
        await page.waitForFunction(ticks => !tm4Port.paused && tm4Port.simulationTicks > ticks, paused.ticks);
        assert.equal(await page.evaluate(() => tm4Port.interpolateMotion), true);

        if (!(await page.locator('#render-settings').evaluate(node => node.open))) await rendering.click();
        await page.locator('#render-reset').click();
        assert.equal(await toggle.isChecked(), false);
        await page.waitForFunction(() => !tm4Port.interpolateMotion && tm4Port.renderTiming.vblanks === 2);
        await measure('RESET', 26, 34);
        assert.deepEqual(errors, []);
        console.log('PASS interpolation cadence, driving, pause and Restore defaults');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
