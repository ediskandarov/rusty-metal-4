/* global tm4Port */
import assert from "node:assert/strict";

// Compare the same sign with and without selection: navigation alone cannot
// detect a loading screen overwriting the menu's textures or palettes.
export default async function checkMenuHighlight(page, prefix) {
  const press = async (key) => {
    await page.keyboard.press(key, { delay: 150 });
    await page.waitForTimeout(300);
  };
  async function measureNewGame(label) {
    const png = await page.locator("canvas").screenshot({ path: `${prefix}-${label}.png` });
    return page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        Math.floor(image.width * 0.1),
        Math.floor(image.height * 0.06),
        Math.floor(image.width * 0.43),
        Math.floor(image.height * 0.25),
      ).data;
      let green = 0;
      let visible = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        green += pixels[i + 1] - (pixels[i] + pixels[i + 2]) / 2;
        if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 24) visible++;
      }
      return { green: green / (pixels.length / 4), visible: visible / (pixels.length / 4) };
    }, png.toString("base64"));
  }
  assert.equal(await page.evaluate(() => tm4Port.screen), "main");
  assert.equal(await page.evaluate(() => tm4Port.selected), 0);
  const selected = await measureNewGame("selected");
  await press("ArrowUp");
  assert.equal(await page.evaluate(() => tm4Port.selected), 2);
  const unselected = await measureNewGame("unselected");
  assert(
    unselected.visible > 0.5,
    `Unselected New Game must retain its background texture (${unselected.visible})`,
  );
  assert(
    selected.green - unselected.green > 2,
    `New Game must visibly glow green when selected (${selected.green} vs ${unselected.green})`,
  );
  await press("ArrowDown");
  assert.equal(await page.evaluate(() => tm4Port.selected), 0);
  console.log("PASS visible menu selection", { selected, unselected });
}
