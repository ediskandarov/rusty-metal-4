const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, args: ['--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
        if (message.type() === 'error' && !/^\[[ID]\]/.test(message.text())) {
            errors.push(message.text());
        }
    });
    const state = () => page.evaluate(() => tm4Port);
    const sample = async () => {
        const start = await state();
        await page.waitForTimeout(2000);
        const end = await state();
        return {ticks:end.simulationTicks - start.simulationTicks, frames:end.levelFrames - start.levelFrames};
    };
    try {
        await page.goto(process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/');
        await require('./browser_startup.cjs')(page);
        // Let the original menu idle counter start its random attract-mode match.
        await page.waitForFunction(() => tm4Port.screen === 'level' && tm4Port.levelFrames > 10, null, { timeout: 120000 });
        console.log('DEMO', (await state()).level);
        await page.keyboard.down('ArrowDown');
        await page.waitForFunction(() => tm4Port.demoFrozen === true);
        const frozen = await state();
        await page.waitForTimeout(1000);
        const held = await state();
        assert.equal(held.simulationTicks, frozen.simulationTicks);
        assert.equal(held.carTicks, frozen.carTicks);
        assert.equal(held.levelFrames, frozen.levelFrames);
        assert.deepEqual([held.carX, held.carY, held.carZ], [frozen.carX, frozen.carY, frozen.carZ]);
        await page.keyboard.up('ArrowDown');
        await page.waitForFunction(t => !tm4Port.demoFrozen && tm4Port.simulationTicks > t,
            frozen.simulationTicks);
        console.log('PASS Down freezes simulation and display until release');
        const normal = await sample();
        await page.keyboard.down('ArrowLeft');
        await page.waitForTimeout(300);
        const slow = await sample();
        await page.keyboard.up('ArrowLeft');
        assert(normal.ticks > 8 && slow.ticks > 0);
        assert(slow.ticks < normal.ticks * 0.8, JSON.stringify({normal,slow}));
        console.log('PASS Left adds original three VBlanks per iteration', {normal,slow});
        await page.keyboard.down('ArrowRight');
        await page.waitForTimeout(300);
        const skipped = await sample();
        await page.keyboard.up('ArrowRight');
        assert(skipped.ticks > 8);
        assert(Math.abs(skipped.frames * 2 - skipped.ticks) <= 3, JSON.stringify(skipped));
        await page.waitForFunction(() => tm4Port.demoDrawEnabled === true);
        const restored = await sample();
        assert(Math.abs(restored.frames - restored.ticks) <= 1, JSON.stringify(restored));
        console.log('PASS Right skips every second render, release restores drawing', {skipped,restored});
        await page.keyboard.down('Enter');
        await page.waitForTimeout(150);
        await page.keyboard.up('Enter');
        await page.waitForFunction(() => tm4Port.screen === 'main' && tm4Port.menuReady, null, { timeout: 30000 });
        assert.notEqual(await page.evaluate(() => tm4Port.paused), true);
        assert.deepEqual(errors, []);
        console.log('PASS original idle attract mode starts a match; Start returns to menu without pausing');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
