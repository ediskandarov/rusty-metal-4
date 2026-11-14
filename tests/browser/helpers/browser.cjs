const { existsSync, mkdirSync } = require("node:fs");
const { chromium } = require("playwright");

// CI uses TM4_CHROME. Local macOS uses installed Chrome; other hosts use
// Playwright's Chromium unless an executable is explicitly selected.
async function launchBrowser(options = {}) {
  const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath =
    process.env.TM4_CHROME ||
    (process.platform === "darwin" && existsSync(systemChrome) ? systemChrome : undefined);
  mkdirSync("build/checks", { recursive: true });
  return chromium.launch({
    headless: true,
    ...options,
    ...(executablePath ? { executablePath, channel: undefined } : {}),
    args: ["--enable-unsafe-swiftshader", ...(options.args || [])],
  });
}

module.exports = { launchBrowser };
