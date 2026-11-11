/* global textureFilterDraws, textureMipStats, tm4Port */
const assert = require("node:assert/strict");
const { readFile, mkdir } = require("node:fs/promises");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

(async () => {
  // Compile the actual patched PsyZ shaders, not a second copy of the algorithm.
  const source = await readFile("build/dev/psyz-runtime/platform/sdl3_gl.c", "utf8");
  function shader(name) {
    const start = source.indexOf(`static const char ${name}[]`);
    assert(start >= 0);
    const body = source.slice(start, source.indexOf("};", start));
    return [...body.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => JSON.parse(m[0])).join("");
  }
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--mute-audio"],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      /GL_INVALID|GL_ERROR|shader compilation failed|shader linking failed|Mipmap.*failed|decoder unavailable/.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  try {
    await page.goto("about:blank");
    const samples = await page.evaluate(
      ({ vertex, fragment, prologue }) => {
        const gl = document.createElement("canvas").getContext("webgl2");
        if (!gl) throw new Error("WebGL2 unavailable");
        const program = gl.createProgram();
        for (const [kind, body] of [
          [gl.VERTEX_SHADER, vertex],
          [gl.FRAGMENT_SHADER, fragment],
        ]) {
          const shader = gl.createShader(kind);
          gl.shaderSource(shader, prologue + body);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(shader));
          gl.attachShader(program, shader);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);
        const uniform = (name) => gl.getUniformLocation(program, name);
        gl.uniform2f(uniform("targetSize"), 2, 2);
        gl.uniform1i(uniform("texVram"), 0);
        gl.uniform1i(uniform("maskSnapshot"), 0);
        gl.uniform1i(uniform("decodedTexture"), 2);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, gl.createTexture());
        gl.texImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          gl.RGBA8,
          1,
          1,
          2,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.activeTexture(gl.TEXTURE0);
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 4, 0, 0, 4]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttrib4f(2, 128 / 255, 128 / 255, 128 / 255, 1);
        gl.vertexAttrib4f(3, 255, 255, 0, 0);
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        const output = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, output);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0);
        gl.viewport(0, 0, 1, 1);
        gl.disable(gl.DITHER);
        const vram = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, vram);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const results = [];
        for (const bits of [4, 8, 16]) {
          for (const scenario of [
            "opaque",
            "transparent-center",
            "transparent-neighbor",
            "different-mask",
            "mask-pass",
          ]) {
            const data = new Uint8Array(1024 * 512 * 4);
            const red =
              scenario === "transparent-center"
                ? [0, 0, 0, 0]
                : [255, 0, 0, scenario === "mask-pass" ? 255 : 0];
            const blue =
              scenario === "transparent-neighbor"
                ? [0, 0, 0, 0]
                : [0, 0, 255, scenario === "different-mask" ? 255 : 0];
            for (let y = 0; y < 2; y++) {
              if (bits === 16) {
                data.set(red, y * 1024 * 4);
                data.set(blue, (y * 1024 + 1) * 4);
              } else {
                const word = bits === 4 ? 0x21 : 0x201;
                data.set(
                  [
                    Math.round(((word & 31) * 255) / 31),
                    Math.round((((word >> 5) & 31) * 255) / 31),
                    Math.round((((word >> 10) & 31) * 255) / 31),
                    0,
                  ],
                  y * 1024 * 4,
                );
              }
            }
            data.set(red, (4 * 1024 + 1) * 4);
            data.set(blue, (4 * 1024 + 2) * 4);
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA8,
              1024,
              512,
              0,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              data,
            );
            gl.vertexAttrib4f(
              1,
              0.5,
              0,
              4 * 64,
              0x2000 | (bits === 16 ? 0x100 : bits === 8 ? 0x80 : 0),
            );
            gl.uniform1i(uniform("maskPass"), scenario === "mask-pass" ? 1 : 0);
            const colors = [];
            for (const enabled of [0, 1, 2, 0]) {
              gl.uniform1i(uniform("textureFilter"), enabled);
              gl.clearColor(0, 1, 0, 1);
              gl.clear(gl.COLOR_BUFFER_BIT);
              gl.drawArrays(gl.TRIANGLES, 0, 3);
              const pixel = new Uint8Array(4);
              gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
              colors.push(Array.from(pixel));
            }
            results.push({ bits, scenario, colors });
          }
        }
        if (gl.getError() !== gl.NO_ERROR) throw new Error("GL fixture error");

        const footprints = [];
        const size = 32;
        gl.bindTexture(gl.TEXTURE_2D, output);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindTexture(gl.TEXTURE_2D, vram);
        const stripes = new Uint8Array(1024 * 512 * 4);
        for (let y = 0; y < 256; y++)
          for (let x = 0; x < 256; x++)
            stripes.set(x % 2 ? [0, 0, 255, 0] : [255, 0, 0, 0], (y * 1024 + x) * 4);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1024, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, stripes);
        gl.activeTexture(gl.TEXTURE2);
        const mipTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, mipTexture);
        const decoded = new Uint8Array(256 * 256 * 4 * 2);
        for (let y = 0; y < 256; y++)
          for (let x = 0; x < 256; x++)
            decoded.set(x % 2 ? [0, 0, 255, 255] : [255, 0, 0, 255], (y * 256 + x) * 4);
        gl.texImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          gl.RGBA8,
          256,
          256,
          2,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          decoded,
        );
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform4f(uniform("textureRegion"), 0, 0, 256, 256);
        gl.uniform1i(uniform("maskPass"), 0);
        gl.viewport(0, 0, size, size);
        const uvBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
        for (const [name, dx, dy] of [
          ["horizontal", [4, 0], [0, 0.25]],
          ["vertical", [0, 0.25], [4, 0]],
          ["diagonal", [2.8, 2.8], [0.2, -0.2]],
          ["magnified", [0.25, 0], [0, 0.25]],
          ["isotropic", [4, 0], [0, 4]],
        ]) {
          const origin = [16.1, 16.1];
          gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([
              ...origin,
              0,
              0x2100,
              origin[0] + dx[0] * size * 2,
              origin[1] + dx[1] * size * 2,
              0,
              0x2100,
              origin[0] + dy[0] * size * 2,
              origin[1] + dy[1] * size * 2,
              0,
              0x2100,
            ]),
            gl.STATIC_DRAW,
          );
          const pixels = [];
          for (const mode of [1, 2, 3, 4]) {
            gl.uniform1i(uniform("useMipmaps"), mode >= 3);
            if (anisotropy) {
              gl.activeTexture(gl.TEXTURE2);
              gl.texParameterf(
                gl.TEXTURE_2D_ARRAY,
                anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
                mode === 4 ? 4 : 1,
              );
              gl.activeTexture(gl.TEXTURE0);
            }
            gl.uniform1i(uniform("textureFilter"), mode);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            const values = new Uint8Array(size * size * 4);
            gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, values);
            pixels.push(Array.from(values));
          }
          footprints.push({ name, pixels });
        }
        if (gl.getError() !== gl.NO_ERROR) throw new Error("Footprint fixture GL error");
        return { colors: results, footprints };
      },
      {
        vertex: shader("vertex_shader_body"),
        fragment: shader("fragment_shader_body"),
        prologue: shader("shader_prologue_es"),
      },
    );
    for (const { bits, scenario, colors } of samples.colors) {
      assert.deepEqual(colors[0], colors[3], `${bits}-bit ${scenario}: toggling changed nearest`);
      assert.deepEqual(colors[2], colors[1], "Zero footprint must equal bilinear");
      if (scenario === "opaque") {
        assert(colors[0][0] > 245 && colors[0][2] < 5);
        assert(
          colors[1][0] > 110 && colors[1][0] < 145 && colors[1][2] > 110 && colors[1][2] < 145,
          `${bits}-bit: bilinear color ${colors[1]}`,
        );
      } else
        assert.deepEqual(
          colors[1],
          colors[0],
          `${bits}-bit ${scenario}: changed transparency/mask`,
        );
    }
    console.log(
      "PASS: 4/8/16-bit palettes, bilinear colors, transparent cutouts, mask bits, nearest restoration",
    );
    for (const { name, pixels } of samples.footprints) {
      const imbalance = (values) =>
        values.reduce(
          (sum, value, i) => sum + (i % 4 === 0 ? Math.abs(value - values[i + 2]) : 0),
          0,
        ) /
        (values.length / 4);
      if (name !== "magnified") {
        const before = imbalance(pixels[0]);
        for (const index of [2, 3])
          assert(
            imbalance(pixels[index]) < before * 0.4,
            `${name}: mipmaps did not reduce minification aliasing`,
          );
        console.log(
          `${name}: mipmap imbalance ${imbalance(pixels[2]).toFixed(1)}, hardware anisotropy ${imbalance(pixels[3]).toFixed(1)}`,
        );
      }
      if (name === "magnified" || name === "isotropic") {
        assert.deepEqual(pixels[0], pixels[1], name + ": anisotropy must fall back to bilinear");
      } else {
        const error = pixels.map(
          (values) =>
            values.reduce(
              (sum, value, i) => sum + (i % 4 === 0 ? Math.abs(value - values[i + 2]) : 0),
              0,
            ) /
            (values.length / 4),
        );
        assert(error[1] < error[0] * 0.65, name + ": no reduction in stripe aliasing " + error);
        console.log(
          name +
            " stripe imbalance: bilinear=" +
            error[0].toFixed(1) +
            ", anisotropic=" +
            error[1].toFixed(1),
        );
      }
    }
    await page.addInitScript(() => {
      globalThis.textureFilterDraws = [0, 0, 0, 0, 0];
      globalThis.textureMipStats = { draws: 0, generated: 0, anisotropy: 0 };
      const proto = WebGL2RenderingContext.prototype;
      const generate = proto.generateMipmap;
      proto.generateMipmap = function (...args) {
        if (args[0] === this.TEXTURE_2D_ARRAY) textureMipStats.generated++;
        return generate.apply(this, args);
      };
      const draw = proto.drawElements;
      proto.drawElements = function (...args) {
        const program = this.getParameter(this.CURRENT_PROGRAM);
        const location = program && this.getUniformLocation(program, "textureFilter");
        if (location) {
          const mode = this.getUniform(program, location);
          textureFilterDraws[mode]++;
          const used = this.getUniformLocation(program, "useMipmaps");
          if (used && this.getUniform(program, used)) {
            textureMipStats.draws++;
            if (mode === 4 && !textureMipStats.anisotropy) {
              const extension = this.getExtension("EXT_texture_filter_anisotropic");
              if (extension) {
                const active = this.getParameter(this.ACTIVE_TEXTURE);
                this.activeTexture(this.TEXTURE2);
                textureMipStats.anisotropy = this.getTexParameter(
                  this.TEXTURE_2D_ARRAY,
                  extension.TEXTURE_MAX_ANISOTROPY_EXT,
                );
                this.activeTexture(active);
              }
            }
          }
        }
        return draw.apply(this, args);
      };
    });
    await page.goto(process.env.TM4_WEB_URL || "http://127.0.0.1:8174/");
    await require("./browser_startup.cjs")(page);
    await page.locator("#render-settings > summary").click();
    for (const value of ["0", "1", "2", "3", "4", "0", "2", "1"]) {
      const old = await page.evaluate((value) => textureFilterDraws[Number(value)], value);
      await page.selectOption("#texture-filtering", value);
      await page.waitForFunction(({ value, old }) => textureFilterDraws[Number(value)] > old, {
        value,
        old,
      });
    }
    await page.selectOption("#render-preset", "ps1");
    assert.equal(await page.locator("#texture-filtering").inputValue(), "0");
    await page.selectOption("#render-preset", "ultra");
    assert.equal(await page.locator("#texture-filtering").inputValue(), "1");
    await page.selectOption("#render-antialiasing", "0");
    await page.locator("#render-settings > summary").click();
    await page.locator("canvas").click();
    async function press(key) {
      await page.keyboard.down(key);
      await page.waitForTimeout(150);
      await page.keyboard.up(key);
      await page.waitForTimeout(150);
    }
    await press("x");
    await page.waitForFunction(() => tm4Port.screen === "newgame" && tm4Port.menuReady);
    await press("x");
    await page.waitForFunction(() => tm4Port.screen === "carsel" && tm4Port.menuReady);
    const output = resolve("build/checks/texture-filtering");
    await mkdir(output, { recursive: true });
    for (const [value, label] of [
      ["0", "nearest"],
      ["1", "bilinear"],
      ["2", "anisotropic"],
      ["3", "mipmaps"],
      ["4", "mipmaps-anisotropic"],
    ]) {
      await page.locator("#render-settings > summary").click();
      await page.selectOption("#texture-filtering", value);
      await page.locator("#render-settings > summary").click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(output, `car-${label}.png`) });
    }
    await page.locator("canvas").click();
    await press("x");
    await page.waitForFunction(() => tm4Port.carTicks > 30, null, { timeout: 30000 });
    for (const [value, label] of [
      ["1", "bilinear"],
      ["2", "anisotropic"],
      ["3", "mipmaps"],
      ["4", "mipmaps-anisotropic"],
    ]) {
      await page.locator("#render-settings > summary").click();
      await page.selectOption("#texture-filtering", value);
      await page.locator("#render-settings > summary").click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: resolve(output, "level-" + label + ".png") });
    }
    const mipStats = await page.evaluate(() => textureMipStats);
    assert(mipStats.draws > 0 && mipStats.generated > 0, "mipmap cache was not used in the game");
    assert(mipStats.anisotropy > 1, "hardware anisotropy was not enabled in the game");
    console.log("Game mipmap cache:", mipStats);
    assert.deepEqual(errors, []);
    console.log("PASS: menu toggles, presets, car selection and gameplay");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
