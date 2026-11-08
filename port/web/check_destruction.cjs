const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, args: ['--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({viewport: {width: 960, height: 800}});
    const errors = [];
    page.on('pageerror', e => {errors.push(String(e));console.error(e);});
    page.on('console', m => {
        if (m.type() === 'error' && !/^\[[ID]\]/.test(m.text()))
            errors.push(m.text());
    });
    await require('./browser_diagnostics.cjs')(page);
    const state = () => page.evaluate(() => tm4Port);
    const press = async key => {
        await page.keyboard.down(key); await page.waitForTimeout(150);
        await page.keyboard.up(key); await page.waitForTimeout(150);
    };
    const screen = name => page.waitForFunction(name => globalThis.tm4Port?.screen === name && tm4Port.menuReady,
        name, {timeout: 30000});
    try {
        await page.goto(process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/');await require('./browser_startup.cjs')(page);
        await screen('main'); await page.locator('canvas').click();
        for (let session = 0; session < 2; ++session) {
            await press('x'); await screen('newgame'); await press('x'); await screen('carsel'); await press('x');
            await page.waitForFunction(() => tm4Port.screen === 'level' && tm4Port.levelFrames > 30,
                null, {timeout: 30000});
            assert((await state()).destroyableInstances > 0);
            assert.equal(await page.evaluate(() => Module._WebTestAimAtDestroyable()), 1);
            const before = await state();
            assert(before.testDestroyable.enabledFaces > 0);
            assert(before.testDestroyable.collisionOwned);
            await page.waitForTimeout(300);
            await page.screenshot({path:`build/web/destruction-${session}-before.png`});
            await page.keyboard.down('e');
            await page.waitForFunction(() => Module._WebTestDestroyablePresent() === 0,
                null, {timeout: 15000});
            await page.keyboard.up('e');
            const after = await state();
            assert(after.destroyedObjects > (before.destroyedObjects || 0));
            assert.equal(after.testDestroyable.enabledFaces, 0);
            assert.equal(after.testDestroyable.collisionEnabled, 0);
            assert.equal(after.testDestroyable.collisionOwned, 0);
            assert(after.fragmentSpawns > (before.fragmentSpawns || 0));
            await page.waitForFunction(n => tm4Port.fragmentDraws > n,
                before.fragmentDraws || 0, {timeout: 5000});
            await page.screenshot({path:`build/web/destruction-${session}.png`});
            await page.waitForFunction(() => { Module._WebTestDestroyablePresent(); return tm4Port.testDestroyable.fragments === 0; },
                null, {timeout: 30000});
            await page.waitForTimeout(250);
            await page.screenshot({path:`build/web/destruction-${session}-cleared.png`});
            console.log('PASS destruction', before.testDestroyableName, {
                health:before.testDestroyableHealth, faces:before.testDestroyable.faces,
                fragments:(await state()).fragmentSpawns - (before.fragmentSpawns || 0),
            });
            await press('Enter'); await page.waitForFunction(() => tm4Port.paused === true);
            await press('ArrowUp'); await press('x'); await press('ArrowUp'); await press('x');
            await screen('main');
            assert.deepEqual(errors, []);
        }
        console.log('PASS machine guns -> destructible world -> fragments -> removal -> reload');
    } catch (e) { console.error('STATE', await state(), 'ERRORS', errors); throw e; }
    finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode = 1;});
