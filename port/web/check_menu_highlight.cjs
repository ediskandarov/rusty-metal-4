const assert = require('node:assert/strict');

// Compare the same sign with and without selection: navigation alone cannot
// detect a loading screen overwriting the menu's textures or palettes.
module.exports = async function checkMenuHighlight(page, prefix) {
    const press = async key => {
        await page.keyboard.press(key, {delay: 150});
        await page.waitForTimeout(300);
    };
    async function greenOnNewGame(label) {
        const png = await page.locator('canvas').screenshot({path: `${prefix}-${label}.png`});
        return page.evaluate(async base64 => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(Math.floor(image.width * 0.10),
                Math.floor(image.height * 0.06), Math.floor(image.width * 0.43),
                Math.floor(image.height * 0.25)).data;
            let green = 0;
            for (let i = 0; i < pixels.length; i += 4)
                green += pixels[i + 1] - (pixels[i] + pixels[i + 2]) / 2;
            return green / (pixels.length / 4);
        }, png.toString('base64'));
    }
    assert.equal(await page.evaluate(() => tm4Port.screen), 'main');
    assert.equal(await page.evaluate(() => tm4Port.selected), 0);
    const selected = await greenOnNewGame('selected');
    await press('ArrowUp');
    assert.equal(await page.evaluate(() => tm4Port.selected), 2);
    const unselected = await greenOnNewGame('unselected');
    assert(selected - unselected > 2,
        `New Game must visibly glow green when selected (${selected} vs ${unselected})`);
    await press('ArrowDown');
    assert.equal(await page.evaluate(() => tm4Port.selected), 0);
    console.log('PASS visible menu selection', {selected, unselected});
};
