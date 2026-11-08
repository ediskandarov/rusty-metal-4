const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const cases = [
    {car:'Microblast', file:'toy', windup:true},
    {car:'Gen. Warthog', file:'tank', treads:true},
    {car:'Minion', file:'minion', treads:true},
    {car:'Crusher', file:'crusher', treads:true},
    {car:'Sweet Tooth', file:'stooth', flame:true},
];
(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless:true, args:['--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({viewport:{width:960,height:800}});
    await require('./browser_diagnostics.cjs')(page);
    const errors = [];
    page.on('pageerror', e => {errors.push(String(e)); console.error(e);});
    page.on('console', m => {
        if (m.type() === 'error' && !/^\[[ID]\]/.test(m.text())) {
            errors.push(m.text()); console.error(m.text());
        }
    });
    const state = () => page.evaluate(() => tm4Port);
    const model = () => page.evaluate(() => {Module._WebTestReadCarModel(); return tm4Port.carModel;});
    const press = async key => {
        await page.keyboard.down(key); await page.waitForTimeout(150);
        await page.keyboard.up(key); await page.waitForTimeout(150);
    };
    const screen = name => page.waitForFunction(name => globalThis.tm4Port?.screen === name && tm4Port.menuReady,
        name, {timeout:30000});
    try {
        await page.goto(process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/');await require('./browser_startup.cjs')(page);
        await screen('main'); await page.locator('canvas').click();
        await press('ArrowUp'); await press('x'); await screen('options');
        await press('ArrowDown'); await press('ArrowDown'); await press('x'); await screen('password');
        // The original unlock-all password; no direct changes to progression or the car list.
        for (const key of ['s','ArrowRight','ArrowUp','ArrowLeft','q']) await press(key);
        await screen('options'); await press('s'); await screen('main'); await press('ArrowDown');
        const allDebris = !!process.env.TM4_TEST_ALL_CAR_DEBRIS;
        const checkCallbacks = async () => {
            if (process.env.TM4_TEST_CALLBACK_TYPES)
                await require('./check_object_callbacks.cjs')(page);
        };
        let candidates = cases;
        if (allDebris) {
            await press('x'); await screen('newgame'); await press('x'); await screen('carsel');
            const first = (await state()).selectedCar;
            candidates = [];
            for (let step = 0; step < 32; ++step) {
                const car = (await state()).selectedCar;
                if (!candidates.some(test => test.car === car))
                    candidates.push(cases.find(test => test.car === car) || {car});
                await press('ArrowRight');
                if ((await state()).selectedCar === first) break;
            }
            assert.equal(new Set(candidates.map(test => test.car)).size, 22);
            await press('s'); await screen('newgame'); await press('s'); await screen('main');
        }
        const selected = candidates.filter(test => (!process.env.TM4_TEST_CAR || test.car === process.env.TM4_TEST_CAR)
            && (!process.env.TM4_TEST_TREAD_DEBRIS || test.treads));
        assert(selected.length);
        for (let session = 0; session < (allDebris ? 1 : 2); ++session) for (const test of selected) {
            await press('x'); await screen('newgame'); await press('x'); await screen('carsel');
            for (let i = 0; i < 32 && (await state()).selectedCar !== test.car; ++i) await press('ArrowRight');
            assert.equal((await state()).selectedCar, test.car);
            const prior = await state();
            await press('x');
            await page.waitForFunction(() => tm4Port.screen === 'level' && tm4Port.levelFrames > 30,
                null, {timeout:30000});
            const before = await model();
            if (test.file) assert.equal(before.file.toLowerCase(), test.file);
            const artifact = before.file.toLowerCase();
            assert(before.faces > 0);
            await checkCallbacks();
            if (test.windup) {
                assert(Math.abs(before.windupAngle) < 4096);
                await page.waitForFunction(angle => {
                    Module._WebTestReadCarModel(); return tm4Port.carModel.windupAngle !== angle;
                }, before.windupAngle, {timeout:5000});
            }
            if (test.treads) {
                await page.keyboard.down('x');
                try {
                    await page.waitForFunction(before => {
                        Module._WebTestReadCarModel(); const m = tm4Port.carModel;
                        return m.uvHash !== before.uvHash
                            && (m.leftWheel !== before.leftWheel || m.rightWheel !== before.rightWheel);
                    }, before, {timeout:10000});
                } finally {await page.keyboard.up('x');}
            }
            if (test.flame) {
                await page.waitForFunction(prior => tm4Port.lastRay === 'sweetTooth'
                    && tm4Port.raySpawns > (prior.raySpawns || 0)
                    && tm4Port.rayDraws > (prior.rayDraws || 0), prior, {timeout:10000});
            }
            if (process.env.TM4_TEST_TREAD_DEBRIS || allDebris) {
                const priorDebris = await state();
                await page.evaluate(() => Module._WebTestCoopDamage(0));
                await page.waitForFunction(() => !tm4Port.carAlive, null, {timeout: 10000});
                await page.waitForFunction(prior => tm4Port.debrisSpawns > (prior.debrisSpawns || 0)
                    && tm4Port.debrisDraws > (prior.debrisDraws || 0), priorDebris, {timeout: 10000});
                await checkCallbacks();
                await page.screenshot({path:`build/web/tread-debris-${artifact}-${session}.png`});
                await page.waitForFunction(prior => tm4Port.carAlive && tm4Port.cameraAttached
                    && tm4Port.debrisRemoved > (prior.debrisRemoved || 0), priorDebris, {timeout: 20000});
                await checkCallbacks();
                console.log('PASS debris survives car destruction and respawn', test.car, session);
            }
            await page.screenshot({path:`build/web/car-module-${artifact}-${session}.png`});
            assert.deepEqual(errors, []);
            console.log('PASS', test.car, session, before, await model());
            await press('Enter'); await page.waitForFunction(() => tm4Port.paused === true);
            await press('ArrowUp'); await press('x'); await press('ArrowUp'); await press('x'); await screen('main');
            if (test.flame) assert((await state()).rayRemoved > (prior.rayRemoved || 0));
        }
        assert.deepEqual(errors, []);
        console.log('PASS car-specific animation, treads, attached flame and repeated session teardown');
    } catch (e) {console.error('STATE', await state(), 'ERRORS', errors); throw e;}
    finally {await browser.close();}
})().catch(e => {console.error(e); process.exitCode = 1;});
