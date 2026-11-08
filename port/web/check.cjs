/* Browser integration check. Install Playwright in ignored build/browser-test;
 * run with NODE_PATH=build/browser-test/node_modules node port/web/check.cjs. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

const url = process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/';
const output = path.resolve('build/web/browser-check');

async function observeAudio(page) {
    await page.evaluate(() => {
        const sdl = Module.SDL3;
        if (sdl.audioContext.state !== 'running') throw new Error('Browser audio is suspended');
        const node = sdl.audio_playback.scriptProcessorNode;
        const render = node.onaudioprocess;
        globalThis.audioProbe = { buffers: 0, samples: 0, nonzero: 0, peak: 0 };
        node.onaudioprocess = event => {
            render(event);
            const probe = globalThis.audioProbe;
            probe.buffers++;
            for (let channel = 0; channel < event.outputBuffer.numberOfChannels; channel++) {
                for (const value of event.outputBuffer.getChannelData(channel)) {
                    probe.samples++;
                    if (value) probe.nonzero++;
                    probe.peak = Math.max(probe.peak, Math.abs(value));
                }
            }
        };
    });
}

async function scenario(browser, deathmatch) {
    const context = await browser.newContext({ viewport: { width: 960, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || String(error)));
    page.on('console', message => {
        const text = message.text();
        // This PsyZ revision sends informational logs to stderr too.
        if (message.type() === 'error' && !/^\[[ID]\]/.test(text)) errors.push(text);
    });
    const state = () => page.evaluate(() => globalThis.tm4Port);
    async function press(key) {
        await page.keyboard.down(key);
        await page.waitForTimeout(150);
        await page.keyboard.up(key);
        await page.waitForTimeout(150);
    }
    async function screen(name) {
        await page.waitForFunction(name => globalThis.tm4Port?.screen === name
            && globalThis.tm4Port?.menuReady, name, { timeout: 30000 });
        assert.deepEqual(errors, []);
    }
    try {
        await page.goto(url);await require('./browser_startup.cjs')(page);
        await screen('main');
        await page.locator('canvas').click();
        await observeAudio(page);
        await press('x');
        await screen('newgame');
        if (deathmatch) await press('ArrowRight');
        await press('x');
        if (deathmatch) {
            await screen('dmatch');
            await press('ArrowRight');
            await press('ArrowRight');
            await press('x');
        }
        await screen('carsel');
        if (deathmatch) await press('ArrowRight');
        const menuAudio = await page.evaluate(() => globalThis.audioProbe);
        assert(menuAudio.nonzero > 0, 'Original menu sounds must reach the audio device');
        const selected = await state();
        assert.equal(selected.selectedWorld, deathmatch ? 'Road Rage' : 'Construction Yard');
        assert.equal(selected.selectedCar, deathmatch ? 'Pizza Boy' : 'Orbital');
        const label = deathmatch ? 'deathmatch' : 'tournament';
        await page.screenshot({ path: path.join(output, `${label}-selection.png`) });
        await press('x');
        await page.waitForFunction(() => globalThis.tm4Port?.carTicks > 30, null,
            { timeout: 30000 });
        await page.evaluate(() => {
            globalThis.audioProbe = { buffers: 0, samples: 0, nonzero: 0, peak: 0 };
        });
        const start = await state();
        assert.equal(start.level, selected.selectedWorld);
        assert.equal(start.car, selected.selectedCar);
        assert.equal(start.opponents, deathmatch ? 1 : 2);
        assert.equal(start.cars.length, 1 + start.opponents);
        assert(start.aiEnabled, 'Original AI must be enabled');
        assert(start.pickupInstances > 0 && start.pickupDraws > 0,
            'Original level pickups must be created and drawn');
        assert(start.hudGlyphs > 0, 'Original HUD must emit text after releasing menu fonts');
        let machineGunKey;
        if (!deathmatch) {
            // Default R2 is E in PsyZ. Read the binding rather than assuming the action.
            const keys = ['w', 'e', 'q', 'r', 's', 'd', 'x', 'z', 'Backspace', '1', '2',
                'Enter', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'];
            const button = start.controlBindings[8]; // GameControlMachineGuns
            assert(button && !(button & (button - 1)), 'Machine guns use one digital button');
            const key = keys[Math.log2(button)];
            machineGunKey = key;
            await page.keyboard.down(key);
            await page.waitForTimeout(1800);
            await page.screenshot({ path: path.join(output, 'tournament-machine-gun.png') });
            await page.waitForTimeout(1500);
            const fired = await state();
            await fs.writeFile(path.join(output, 'machine-gun-state.json'),
                JSON.stringify({ start, fired, errors }, null, 2));
            assert(fired.bulletSpawns > 1 && fired.bulletDraws > 0);
            assert.deepEqual(errors, []);
        }
        await page.keyboard.down('x');
        await page.waitForTimeout(3500);
        await page.keyboard.down('ArrowRight');
        await page.waitForTimeout(1000);
        await page.keyboard.up('ArrowRight');
        await page.keyboard.up('x');
        if (machineGunKey) await page.keyboard.up(machineGunKey);
        await page.waitForTimeout(500);
        // A curb or ramp can leave the wheels airborne at the end of the timed input.
        await page.waitForFunction(() => globalThis.tm4Port?.carAlive
            && globalThis.tm4Port.carContact, null, { timeout: 8000 });
        if (machineGunKey) {
            // Starting positions face different directions. Sweep fire while driving;
            // a fixed burst from spawn can fly through open space without hitting anything.
            await page.waitForFunction(() => tm4Port.bulletImpacts > 0
                && tm4Port.animSpawns > 0 && tm4Port.animDraws > 0, null, {timeout:15000});
            console.log('PASS machine gun: original input -> bullets -> world impacts -> animated effects');
        }
        const end = await state();
        await fs.writeFile(path.join(output, `${label}-state.json`), JSON.stringify({ start, end, errors }, null, 2));
        await page.screenshot({ path: path.join(output, `${label}-driving.png`) });
        assert(end.carTicks - start.carTicks >= 100);
        assert(Math.hypot(end.carX - start.carX, end.carZ - start.carZ) > 1000);
        assert(end.carContact && end.renderedFaces);
        const opponents = start.cars.filter(car => car.control === 2);
        for (const opponent of opponents) {
            const current = end.cars.find(car => car.name === opponent.name);
            assert(current && current.ai, `Opponent ${opponent.name} must still be active`);
            assert(Math.hypot(current.x - opponent.x, current.z - opponent.z) > 100,
                `Original AI must move ${opponent.name}`);
        }
        assert.equal(end.carWeaponSlots, 20);
        assert(end.carAlive && end.carHealth > 0 && end.cameraAttached);
        assert(end.engineVoice >= 0 && end.enginePitch > 0);
        const levelAudio = await page.evaluate(() => globalThis.audioProbe);
        assert(levelAudio.nonzero > 0, 'Original engine bank must reach the audio device');
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(output, `${label}-driving.png`) });
        console.log(`PASS ${label}: original menu -> ${end.car} / ${end.level} -> driving`);
        return { selected, start, end, menuAudio, levelAudio };
    } finally {
        await context.close();
    }
}

async function remappedControls(browser) {
    const context = await browser.newContext();
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const state = () => page.evaluate(() => globalThis.tm4Port);
    async function press(key) {
        await page.keyboard.press(key, { delay: 120 });
        await page.waitForTimeout(300);
    }
    async function screen(name) {
        await page.waitForFunction(name => globalThis.tm4Port?.screen === name
            && globalThis.tm4Port.menuReady, name, { timeout: 30000 });
    }
    try {
        await page.goto(url);await require('./browser_startup.cjs')(page);
        await screen('main');
        await page.locator('canvas').click();
        await press('x');
        await screen('newgame');
        await press('x');
        await screen('carsel');
        await press('z');
        await screen('psetting');
        await press('ArrowDown');
        await press('ArrowDown');
        await press('x');
        await screen('controll');
        for (let i = 0; i < 4; i++) await press('ArrowDown');
        assert.equal((await state()).controlAction, 4); // Gas.
        await press('x');
        await press('ArrowUp');
        assert.equal((await state()).menuGasBinding, 0x1040);
        for (let i = 0; i < 8; i++) await press('ArrowDown');
        assert.equal((await state()).controlAction, 12); // No function.
        await press('x');
        await press('x'); // Remove Cross from its previous assignments.
        assert.equal((await state()).menuGasBinding, 0x1000);
        await page.screenshot({ path: path.join(output, 'custom-bindings.png') });
        await press('s');
        await screen('psetting');
        await press('s');
        await screen('carsel');
        await press('x');
        await page.waitForFunction(() => /SAVE SETTINGS/.test(tm4Port.dialog));
        await press('x'); // Save the changed binding before starting.
        await page.waitForFunction(() => globalThis.tm4Port?.carTicks > 30, null,
            { timeout: 30000 });
        assert.equal((await state()).carGasBinding, 0x1000);
        await page.keyboard.down('x');
        await page.waitForTimeout(500);
        assert.equal((await state()).carThrottle, 0);
        await page.keyboard.up('x');
        await page.keyboard.down('ArrowUp');
        await page.waitForTimeout(1000);
        assert.equal((await state()).carThrottle, 15);
        await page.keyboard.up('ArrowUp');
        await page.keyboard.down('s');
        await page.waitForTimeout(300);
        assert.equal((await state()).carGear, 0);
        assert.equal((await state()).carThrottle, 15);
        await page.keyboard.up('s');
        await page.waitForTimeout(300);
        assert.equal((await state()).carGear, 2);
        await page.keyboard.down('z');
        await page.waitForTimeout(300);
        assert.equal((await state()).carEbrake, 1);
        await page.keyboard.up('z');
        assert.deepEqual(errors, []);
        await page.reload();await require('./browser_startup.cjs')(page);
        await screen('main');
        assert.equal((await state()).menuGasBinding, 0x1000);
        console.log('PASS original binding editor -> saved custom gas, reverse and handbrake');
    } finally {
        await context.close();
    }
}

async function savedSettings(browser) {
    const context = await browser.newContext();
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    async function press(key) {
        await page.keyboard.down(key);
        await page.waitForTimeout(140);
        await page.keyboard.up(key);
        await page.waitForTimeout(800);
    }
    try {
        await page.goto(url);await require('./browser_startup.cjs')(page);
        await page.waitForFunction(() => globalThis.tm4Port?.menuReady);
        await page.locator('canvas').click();
        await press('ArrowUp'); // Options.
        await press('x');
        await press('x'); // Audio settings.
        assert.equal(await page.evaluate(() => tm4Port.screen), 'audio');
        const before = await page.evaluate(() => tm4Port.soundVolume);
        await press('ArrowLeft');
        const changed = await page.evaluate(() => tm4Port.soundVolume);
        assert(changed < before);
        await press('s');
        await press('s');
        assert.match(await page.evaluate(() => tm4Port.dialog), /SAVE SETTINGS/);
        await press('x');
        await page.waitForFunction(() => tm4Port.screen === 'main' && !tm4Port.dialog
            && localStorage.getItem('tm4.memory-card.0'), null, { timeout: 20000 });
        const card = Buffer.from(await page.evaluate(() => localStorage.getItem('tm4.memory-card.0')), 'base64');
        assert.equal(card.length, 128 * 1024);
        assert.equal(card.subarray(0, 2).toString(), 'MC');
        await page.reload();await require('./browser_startup.cjs')(page);
        await page.waitForFunction(() => globalThis.tm4Port?.frames > 30);
        assert.equal(await page.evaluate(() => tm4Port.soundVolume), changed);
        assert.deepEqual(errors, []);
        console.log('PASS original settings dialog -> memory card -> reload');
    } finally {
        await context.close();
    }
}

(async () => {
    await fs.mkdir(output, { recursive: true });
    const browser = await chromium.launch({
        executablePath: process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
        args: ['--enable-unsafe-swiftshader'],
    });
    try {
        const results = [];
        for (const deathmatch of [false, true]) results.push(await scenario(browser, deathmatch));
        await savedSettings(browser);
        await remappedControls(browser);
        await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
