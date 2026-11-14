/* Capture the real WASM caller before Emscripten's nested ASAN reporting loses it. */
export default async function diagnostics(page) {
  // ASAN can leave Asyncify's frame callback spinning after abort. Let the full
  // report drain, then close this test page so browser waits cannot hang forever.
  let abortTimer;
  page.on("console", (message) => {
    const text = message.text();
    if (process.env.TM4_TEST_SDK_TRACE && /not implemented|does not support|\bstub\b/i.test(text))
      console.error("SDK coverage:", text);
    if (/ERROR: AddressSanitizer|ASAN origin|ASAN context|Last covering MemFree/.test(text))
      console.error(text);
    if (!abortTimer && text.includes("ERROR: AddressSanitizer"))
      abortTimer = setTimeout(() => page.close().catch(() => {}), 1000);
  });
  page.on("pageerror", async (error) => {
    if (!/function signature mismatch|memory access out of bounds|unreachable/i.test(error.message))
      return;
    console.error("WASM trap:", error.stack);
    try {
      console.error(
        "WASM context:",
        await page.evaluate(() => ({
          level: globalThis.tm4Port?.level,
          frames: globalThis.tm4Port?.levelFrames,
          ticks: globalThis.tm4Port?.simulationTicks,
          display: globalThis.tm4Port?.lastDisplay,
          debris: globalThis.tm4Port?.lastDebris,
        })),
      );
    } catch (error) {
      console.error("WASM context unavailable:", error.message);
    }
  });
  page.on("close", () => clearTimeout(abortTimer));
  await page.addInitScript(() => {
    // Emscripten ASAN can lose the caller stack while reporting a nested error.
    Error.stackTraceLimit = 100;
    const reportError = console.error.bind(console);
    let reportedAsan = false;
    console.error = (...args) => {
      if (
        reportedAsan &&
        args.some((value) =>
          /nested bug in the same thread|user callback triggered after runtime exited/.test(
            String(value),
          ),
        )
      )
        return;
      reportError(...args);
      if (
        !reportedAsan &&
        args.some((value) => String(value).includes("ERROR: AddressSanitizer"))
      ) {
        reportedAsan = true;
        reportError(new Error("ASAN origin").stack);
        reportError(
          "ASAN context",
          JSON.stringify({
            display: globalThis.tm4Port?.lastDisplay,
            debris: globalThis.tm4Port?.lastDebris,
          }),
        );
        const address = /on address (0x[0-9a-f]+)/i.exec(args.join(" "));
        if (address) {
          const value = Number(address[1]);
          const block = (globalThis.tm4FreedBlocks || []).findLast(
            (block) => block.start <= value && value < block.end,
          );
          if (block) reportError("Last covering MemFree", JSON.stringify(block));
        }
      }
    };
  });
}
