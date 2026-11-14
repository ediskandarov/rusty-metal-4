import { $ } from "bun";

export class UsageError extends Error {}

/** @param {() => Promise<void>} action */
export async function runCli(action) {
  try {
    await action();
  } catch (error) {
    if (
      error instanceof UsageError ||
      (error instanceof Error &&
        "code" in error &&
        String(error.code).startsWith("ERR_PARSE_ARGS_"))
    ) {
      console.error("error: " + error.message);
      process.exitCode = 1;
      return;
    }
    if (!(error instanceof $.ShellError)) throw error;
    // Shell output has already streamed to the terminal; do not dump its captured buffers again.
    console.error("error: " + error.message);
    process.exitCode = error.exitCode;
  }
}
