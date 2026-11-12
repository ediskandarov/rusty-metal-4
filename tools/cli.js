import { $ } from "bun";

/** @param {() => Promise<void>} action */
export async function runCli(action) {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof $.ShellError)) throw error;
    // Shell output has already streamed to the terminal; do not dump its captured buffers again.
    console.error("error: " + error.message);
    process.exitCode = error.exitCode;
  }
}
