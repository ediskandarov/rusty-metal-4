const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless:true, args:['--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({viewport:{width:960,height:800}});
    const errors = [];
    page.on('pageerror', e => {errors.push(String(e)); console.error(e);});
    page.on('console', m => {
        if (m.type() === 'error' && !/^\[[ID]\]/.test(m.text())) {
            errors.push(m.text()); console.error(m.text());
        }
    });
    const state = () => page.evaluate(() => {Module._WebTestReadMatchState(); return tm4Port;});
    const press = async key => {
        await page.keyboard.down(key); await page.waitForTimeout(150);
        await page.keyboard.up(key); await page.waitForTimeout(150);
    };
    const screen = name => page.waitForFunction(name => globalThis.tm4Port?.screen === name && tm4Port.menuReady,
        name, {timeout:30000});
    try {
        await page.goto(process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/');await require('./browser_startup.cjs')(page);
        await screen('main'); await page.locator('canvas').click();
        await press('x'); await screen('newgame'); await press('x'); await screen('carsel');
        await press('x');
        await page.waitForFunction(() => tm4Port.screen === 'level' && tm4Port.levelFrames > 30,
            null, {timeout:30000});
        const full = process.env.TM4_TEST_FULL_TOURNAMENT === '1';
        assert.ok(!full || process.env.TM4_TEST_SAVE !== '1', 'full tournament and save routes are separate');
        const initial = await state();
        const rounds = full ? initial.match.tournamentWorlds : 2;
        const visited = new Set();
        for (let round = 0; round < rounds; ++round) {
            const before = await state();
            assert.ok(!visited.has(before.level), "world must not repeat before tournament completion");
            visited.add(before.level);
            console.log("START round", round + 1, "of", rounds, before.level);
            const deadline = Date.now() + 60000;
            while (!(await state()).match.acceptsInput && Date.now() < deadline) {
                await page.evaluate(() => Module._WebTestDefeatOpponents());
                await page.waitForTimeout(500);
                assert.deepEqual(errors, []);
            }
            const won = await state();
            assert((won.match.won || won.match.tournamentWon) && won.match.acceptsInput, JSON.stringify(won.match));
            if (full) assert.equal(!!won.match.tournamentWon, round === rounds - 1);
            assert.equal(won.match.opponents, 0);
            await page.screenshot({path:`build/web/tournament-win-${round}.png`});
            if (process.env.TM4_TEST_SAVE === '1' && round === 1) {
                await press('z');
                await screen('tsave');
                assert.equal((await state()).dialog, '');
                await press('x');
                await page.waitForFunction(() => tm4Port.dialog === 'SAVE COMPLETE!\nCONTINUE?',
                    null, {timeout:15000});
                const saved = await page.evaluate(() => localStorage.getItem('tm4.memory-card.0'));
                assert(saved && Buffer.from(saved, 'base64').length === 128 * 1024);
                await page.waitForTimeout(250);
                await page.screenshot({path:'build/web/tournament-saved.png'});
                await press('x');
            } else {
                await press('x');
            }
            if (full && round === rounds - 1) {
                await page.waitForFunction(() => tm4Port.movie.active && tm4Port.movie.frame > 30,
                    null, {timeout:30000});
                assert.equal((await state()).movie.name, 'ORBITAL');
                await press('Enter');
                assert.equal((await state()).movie.active, true, 'ending must not be skipped');
                await page.waitForFunction(() => !tm4Port.movie.active, null, {timeout:120000});
                const movie = (await state()).movie;
                assert.equal(movie.reason, 'complete');
                assert.equal(movie.frame, movie.frames);
                console.log('PASS tournament victory starts and completes character ending', movie.name);
            }
            await page.waitForFunction(previous => tm4Port.screen === 'level'
                && tm4Port.level !== previous && tm4Port.levelFrames > 30,
                before.level, {timeout:30000});
            const after = await state();
            assert(after.match.progress > before.match.progress);
            assert.equal(after.car, before.car);
            assert.equal(after.match.lives, before.match.lives);
            assert(after.carAlive && after.cameraAttached && after.match.opponents > 0);
            assert.deepEqual(errors, []);
            console.log('PASS tournament progression', before.level, '->', after.level,
                'progress', before.match.progress, '->', after.match.progress);
        }
        if (full) {
            const completed = await state();
            assert.equal(completed.level, initial.level);
            assert.equal(completed.match.progress, 4096);
            assert.equal(visited.size, rounds);
            console.log('PASS full tournament, all worlds, bosses, ending and restart', [...visited]);
        }
        await page.screenshot({path:'build/web/tournament-next-world.png'});
        if (process.env.TM4_TEST_SAVE === '1') {
            const saved = await state();
            await page.reload();await require('./browser_startup.cjs')(page);
            await screen('main'); await page.locator('canvas').click();
            await press('ArrowDown'); await press('x'); await screen('tload');
            await page.waitForTimeout(1000);
            assert.equal((await state()).dialog, '');
            await press('x');
            await page.waitForFunction(() => tm4Port.screen === 'level' && tm4Port.levelFrames > 30,
                null, {timeout:30000});
            const loaded = await state();
            assert.equal(loaded.level, saved.level);
            assert.equal(loaded.car, saved.car);
            assert.equal(loaded.match.progress, saved.match.progress);
            assert.equal(loaded.match.lives, saved.match.lives);
            console.log('PASS persistent tournament load', loaded.level, loaded.match.progress);
            for (let life = loaded.match.lives; life >= 0; --life) {
                const deadline = Date.now() + 15000;
                while ((await state()).carAlive && Date.now() < deadline) {
                    await page.evaluate(() => Module._WebTestDamagePlayer());
                    await page.waitForTimeout(500);
                }
                assert.equal((await state()).carAlive, 0);
                if (life > 0) {
                    await page.waitForFunction(() => tm4Port.carAlive && tm4Port.cameraAttached,
                        null, {timeout:15000});
                    assert.equal((await state()).match.lives, life - 1);
                } else {
                    await page.waitForFunction(() => {
                        Module._WebTestReadMatchState(); return tm4Port.match.lost;
                    }, null, {timeout:5000});
                    await page.screenshot({path:'build/web/tournament-game-over.png'});
                    await screen('main');
                }
                assert.deepEqual(errors, []);
            }
            console.log('PASS lives exhausted -> GAME OVER -> main menu');
        }

    } catch(e) {console.error('FAILED', await state()); throw e;}
    finally {await browser.close();}
})().catch(e => {console.error(e); process.exitCode = 1;});
