const assert = require("node:assert/strict");
const { mkdir } = require("node:fs/promises");
const { resolve } = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const output = resolve("build/checks/mipmaps");
  await mkdir(output, { recursive: true });
  const compiler = Bun.spawn(
    [
      "emcc",
      "-O2",
      "-pthread",
      "-Iport/psyz",
      "-Iexternal/psyz/external/SDL/include",
      "tests/browser/fixtures/texture_mipmaps.c",
      "port/psyz/texture_mipmaps.c",
      "build/dev/psyz/sdl/libSDL3.a",
      "-sUSE_WEBGL2=1",
      "-sMIN_WEBGL_VERSION=2",
      "-sMAX_WEBGL_VERSION=2",
      "-sMODULARIZE=1",
      "-sEXPORT_NAME=createMipTest",
      "-sALLOW_MEMORY_GROWTH=1",
      "-sEXPORTED_FUNCTIONS=_RunMipTests",
      "-o",
      `${output}/mipmaps.js`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  assert.equal(await compiler.exited, 0);
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/")
        return new Response(
          '<canvas id="test" width="32" height="32"></canvas><script src="/mipmaps.js"></script>',
          { headers: { ...headers, "Content-Type": "text/html" } },
        );
      if (!["/mipmaps.js", "/mipmaps.wasm"].includes(path))
        return new Response(null, { status: 404 });
      return new Response(Bun.file(output + path), { headers });
    },
  });
  const browser = await chromium.launch({
    executablePath:
      process.env.TM4_CHROME ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (message) => {
      console.log(message.text());
      if (/GL_INVALID|GL_ERROR|shader.*failed|decoder unavailable|^FAIL/.test(message.text()))
        errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const failures = await page.evaluate(async () => {
      // The harness links the production decoder and cache, including invalidation and GL state.
      const module = await globalThis.createMipTest({ canvas: document.querySelector("canvas") });
      return module._RunMipTests();
    });
    assert.equal(failures, 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: mip levels, palettes, mask layers, atlas bounds, texture windows, cache eviction and GL state",
    );
  } finally {
    await browser.close();
    server.stop(true);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
