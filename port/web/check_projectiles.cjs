/* Original inventory + keyboard launch; diagnostic placement provides a clear firing lane. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const cases = [
    {name:'Fire', slot:1},
    {name:'Mortar', slot:5},
    {name:'Speed', slot:6},
    {name:'MIRV', slot:10, child:'MIRVbaby'},
    {name:'Rain', slot:7, fireballs:true},
    {name:'Rain2', slot:17, child:'Napalm2'},
    {name:'Autolob', slot:14, child:'Mortar2'},
    {name:'Ricochet', slot:9, animation:true},
    {name:'FreezeRemote', slot:15, bomb:true},
];
(async () => {
    const browser = await chromium.launch({
        executablePath:process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless:true, args:['--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({viewport:{width:960,height:800}});
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => {
        if (m.type() === 'error' && !/^\[[ID]\]/.test(m.text())) errors.push(m.text());
    });
    await require('./browser_diagnostics.cjs')(page);
    const state = () => page.evaluate(() => tm4Port);
    const read = () => page.evaluate(() => {Module._WebTestReadEnergyActions(); return tm4Port;});
    const screen = name => page.waitForFunction(name => tm4Port.screen === name && tm4Port.menuReady,
        name, {timeout:30000});
    const press = async (key, down=150) => {
        await page.keyboard.down(key); await page.waitForTimeout(down);
        await page.keyboard.up(key); await page.waitForTimeout(150);
    };
    try {
        await page.goto(process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/');
        await require('./browser_startup.cjs')(page); await page.locator('canvas').click();
        const selected = cases.filter(c => !process.env.TM4_TEST_PROJECTILE || c.name === process.env.TM4_TEST_PROJECTILE);
        assert(selected.length);
        for (const test of selected) {
            await press('x'); await screen('newgame'); await press('x'); await screen('carsel');
            await press('x');
            await page.waitForFunction(() => tm4Port.screen === 'level' && tm4Port.levelFrames > 30,
                null, {timeout:30000});
            assert(await page.evaluate(rear => Module._WebTestPlaceEnergyTarget(rear), test.animation ? 1 : 0) > 0);
            await page.waitForTimeout(1500);
            assert(await page.evaluate(i => Module._WebTestSupplyWeapon(i), test.slot) > 0);
            for (let i=0; i<21 && (await state()).carSelectedWeapon !== test.slot; ++i) await press('r');
            const before = await read();
            assert.equal(before.carSelectedWeapon, test.slot);
            assert.equal(before.weaponName.toLowerCase(), test.name.toLowerCase());
            assert(Math.abs(before.energyAction.target.y - before.carY) < 80);
            if (test.animation) {
                await page.evaluate(() => {
                    tm4Port.previousRicochet = null;
                    tm4Port.ricochetBounce = null;
                    tm4Port.ricochetSamples = [];
                    tm4Port.ricochetSampler = setInterval(() => {
                        Module._WebTestReadRicochet();
                        const now = tm4Port.ricochet, old = tm4Port.previousRicochet;
                        if (!now || (old && now.age === old.age)) return;
                        tm4Port.previousRicochet = now;
                        tm4Port.ricochetSamples.push(now);
                        const reflected = old && now.age > old.age &&
                            ((old.vy > 0 && old.vy < 20000 && now.vy < 0 && now.vy > -20000)
                                || old.vx * now.vx + old.vz * now.vz < 0);
                        if (reflected) tm4Port.ricochetBounce = {before:old, after:now};
                    }, 8);
                });
            }
            await press('w', 60);
            const fired = await state();
            assert.equal(fired.weaponAmmo, before.weaponAmmo - 1);
            if (test.bomb) {
                assert.equal(fired.bombSpawns, (before.bombSpawns || 0) + 1);
                assert.equal(fired.lastBomb.toLowerCase(), test.name.toLowerCase());
                await page.waitForTimeout(1500);
                await press('w', 60);
                assert.equal((await state()).weaponAmmo, fired.weaponAmmo);
                await page.waitForFunction(before => tm4Port.bombRemoved > (before.bombRemoved || 0), before);
                await page.waitForFunction(() => {
                    Module._WebTestReadEnergyActions(); return tm4Port.energyAction.freeze > 0;
                }, null, {timeout:5000});
                await page.waitForFunction(() => {
                    Module._WebTestReadEnergyActions(); return tm4Port.energyAction.freeze === 0;
                }, null, {timeout:7000});
            } else {
                assert.equal((fired.playerProjectileSpawns?.[test.name] || 0) -
                    (before.playerProjectileSpawns?.[test.name] || 0), 1);
                if (test.child) {
                    await page.waitForFunction(({before, test}) =>
                        (tm4Port.playerProjectileSpawns?.[test.child] || 0) >
                        (before.playerProjectileSpawns?.[test.child] || 0), {before,test}, {timeout:6000});
                }
                if (test.fireballs) {
                    await page.waitForFunction(before => tm4Port.fireballSpawns > (before.fireballSpawns || 0)
                        && tm4Port.fireballDraws > (before.fireballDraws || 0)
                        && tm4Port.fireballRemoved > (before.fireballRemoved || 0), before, {timeout:10000});
                }
                if (test.animation) {
                    assert((await state()).animSpawns > (before.animSpawns || 0));
                    await page.waitForFunction(() => tm4Port.ricochetBounce,
                        null, {timeout:10000});
                    await page.evaluate(() => clearInterval(tm4Port.ricochetSampler));
                }
                await page.waitForFunction(({before,test}) =>
                    (tm4Port.playerProjectileRemoved?.[test.name] || 0) >
                    (before.playerProjectileRemoved?.[test.name] || 0), {before,test}, {timeout:40000});
                if (test.child) {
                    const spawned = (await state()).playerProjectileSpawns[test.child] -
                        (before.playerProjectileSpawns?.[test.child] || 0);
                    await page.waitForFunction(({before,test,spawned}) =>
                        (tm4Port.playerProjectileRemoved?.[test.child] || 0) -
                        (before.playerProjectileRemoved?.[test.child] || 0) >= spawned,
                        {before,test,spawned}, {timeout:12000});
                }
                if (test.fireballs) {
                    const spawned = (await state()).fireballSpawns;
                    await page.waitForFunction(n => tm4Port.fireballRemoved >= n, spawned, {timeout:12000});
                }
            }
            assert.deepEqual(errors, []);
            await page.screenshot({path:`build/web/projectile-${test.name}.png`});
            console.log('PASS projectile', test.name, {spawns:(await state()).playerProjectileSpawns,
                fireballs:(await state()).fireballSpawns, bounce:(await state()).ricochetBounce});
            await press('Enter'); await page.waitForFunction(() => tm4Port.paused);
            await press('ArrowUp'); await press('x'); await press('ArrowUp'); await press('x');
            await screen('main');
        }
    } catch(e) {
        console.error('STATE', await read(), 'ERRORS', errors);
        await page.screenshot({path:'build/web/projectile-failure.png'}); throw e;
    } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode=1;});
