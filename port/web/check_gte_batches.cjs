const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.TM4_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, args: ['--enable-unsafe-swiftshader'],
    });
    try {
        const page = await browser.newPage();
        await require('./browser_diagnostics.cjs')(page);
        const errors = [];
        page.on('pageerror', error => {errors.push(String(error)); console.error(error);});
        page.on('console', message => {
            if (message.type() === 'error' && !/^\[[ID]\]/.test(message.text())) {
                errors.push(message.text()); console.error(message.text());
            }
        });
        await page.goto((process.env.TM4_WEB_URL || 'http://127.0.0.1:8080/') + 'gte-batches-check/');
        await page.waitForFunction(() => globalThis.tm4GteBatchesPassed, null, {timeout: 30000});
        assert.deepEqual(errors, []);
        console.log('PASS partial GTE batches: exact allocations, unchanged valid screen coordinates and depth');
    } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
