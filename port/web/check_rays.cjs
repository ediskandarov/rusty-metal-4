const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const contacts = process.env.TM4_TEST_CONTACTS === '1';

(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
        args: ['--enable-unsafe-swiftshader'],
    });
    try {
        for (const car of (process.env.TM4_TEST_CAR ? [process.env.TM4_TEST_CAR] : ['Drag Queen', 'Goggle Eyes'])) {
            const context = await browser.newContext({ viewport: { width: 960, height: 800 } });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', e => { errors.push(String(e)); console.error(e); });
            page.on('console', m => {
                if (m.type() === 'error' && !/^\[[ID]\]/.test(m.text())) {
                    errors.push(m.text());
                    console.error(m.text());
                }
            });
            const state = () => page.evaluate(() => tm4Port);
            const press = async key => {
                await page.keyboard.down(key);
                await page.waitForTimeout(150);
                await page.keyboard.up(key);
                await page.waitForTimeout(150);
            };
            const screen = name => page.waitForFunction(
                name => globalThis.tm4Port?.screen === name && tm4Port.menuReady,
                name, { timeout: 30000 });
            try {
                await page.goto(process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/');await require('./browser_startup.cjs')(page);
                await screen('main');
                await page.locator('canvas').click();
                await press('x'); await screen('newgame');
                await press('x'); await screen('carsel');
                for (let i = 0; i < 30 && (await state()).selectedCar !== car; ++i)
                    await press('ArrowRight');
                assert.equal((await state()).selectedCar, car);
                await press('x');
                await page.waitForFunction(() => tm4Port.carTicks > 30, null, { timeout: 30000 });
                let targetHealth;
                if (contacts) {
                    targetHealth = await page.evaluate(() => Module._WebTestPlaceWeaponTarget(500));
                    assert(targetHealth > 0);
                }
                const before = await state();
                assert.equal(before.carSelectedWeapon, 0);
                await press('w');
                const ray = car === 'Drag Queen';
                await page.waitForFunction(({ before, ray }) => ray
                    ? tm4Port.raySpawns > (before.raySpawns || 0) && tm4Port.rayDraws > (before.rayDraws || 0)
                    : tm4Port.flameSpawns > (before.flameSpawns || 0) && tm4Port.animDraws > (before.animDraws || 0),
                    { before, ray }, { timeout: 10000 });
                const fired = await state();
                assert(fired.weaponAmmo < before.weaponAmmo, 'Original special must consume ammunition');
                await page.screenshot({ path: `build/web/special-${ray ? 'ray' : 'flame'}.png` });
                if (ray)
                    await page.waitForFunction(n => tm4Port.rayRemoved > n, before.rayRemoved || 0, { timeout: 15000 });
                if (contacts) {
                    await page.waitForFunction(({ray, before}) => ray
                        ? tm4Port.rayDamage > (before.rayDamage || 0)
                        : tm4Port.flameDamage > (before.flameDamage || 0), {ray, before}, {timeout: 15000});
                    const afterHealth = await page.evaluate(() => Module._WebTestWeaponTargetHealth());
                    assert(afterHealth > 0, 'Keep the target alive while inspecting its state');
                    assert(await page.evaluate(() => Module._WebTestWeaponTargetBurning()) > 0, 'Hit must ignite the target');
                    console.log('CONTACT', car, {before: targetHealth, after: afterHealth});
                    if (ray) {
                        const rings = (await state()).fireRingSpawns || 0;
                        assert.equal(await page.evaluate(() => Module._WebTestIgniteGround()), 1);
                        await page.waitForFunction(n => tm4Port.fireRingSpawns > n, rings);
                        await page.waitForFunction(() => tm4Port.fireRingRemoved > 0, null, {timeout: 45000});
                        assert((await state()).fireRingPeakParticles > 3, 'Ring must subdivide as it expands');
                        assert((await state()).fireRingPeakRadius > 0);
                        console.log('PASS ground fire expands, subdivides and expires at polygon edges');
                    }
                    if (!ray)
                        await page.waitForFunction(() => Module._WebTestFlameEmitterCount() === 0, null, {timeout: 15000});
                }
                await page.waitForTimeout(2500);
                await press('w');
                await press('Enter');
                await page.waitForFunction(() => tm4Port.paused === true);
                await press('ArrowUp'); await press('x');
                await press('ArrowUp'); await press('x');
                await screen('main');
                await press('x'); await screen('newgame');
                await press('x'); await screen('carsel');
                await press('x');
                await page.waitForFunction(() => tm4Port.screen === 'level' && tm4Port.levelFrames > 30,
                    null, {timeout: 30000});
                assert.deepEqual(errors, []);
                console.log('PASS', car, 'original special -> ammo ->', ray ? 'beam rendering, expiry and session cleanup' : 'flame emitter, animated fire and session cleanup');
            } catch (e) {
                console.log('STATE', await state());
                throw e;
            } finally {
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
