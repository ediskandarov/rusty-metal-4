interface ShutdownContainer {
  readonly running: boolean;
  monitor(): Promise<void>;
  signal(signo: number): void;
  destroy(): Promise<void>;
}

// Allow the HTTP server's 15-second drain deadline before forcing termination.
export async function shutdownContainer(
  container: ShutdownContainer,
  timeoutMs = 20_000,
): Promise<void> {
  if (!container.running) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exited = container.monitor().then(
      () => ({ kind: "exited" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    container.signal(15);
    const result = await Promise.race([
      exited,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (result.kind === "failed") console.error("Container exited with an error", result.error);
    if (result.kind === "timeout")
      console.warn("Container shutdown timed out; forcing termination");
  } catch (error) {
    console.error("Container shutdown failed; forcing termination", error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (container.running) await container.destroy();
}
